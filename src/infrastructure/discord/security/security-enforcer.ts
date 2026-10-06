import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
} from "discord.js";
import type { Logger } from "pino";

import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { TrackedPost } from "../../../domain/security/spam-tracker.js";
import {
  trapDeleteWindowSeconds,
  trapTimeoutMilliseconds,
  type TrapAction,
  type TrapDeleteWindow,
  type TrapSubject,
  type TrapTimeoutDuration,
} from "../../../domain/security/trap-policy.js";

// Permissions only staff hold; a member with any of them is never actioned.
const staffPermissions = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageMessages,
];

// Sweeping reads each channel's recent history, so it is bounded: a guild
// with hundreds of channels still finishes, at the cost of the far ones.
const maxSweptChannels = 150;
const sweepFetchLimit = 100;
const sweepConcurrency = 4;

function subjectOf(
  member: GuildMember | null,
  profile: GuildConfiguration,
  guild: Guild,
  flags: { isBot: boolean; isWebhook: boolean; userId: string },
): TrapSubject {
  return {
    isBot: flags.isBot,
    isWebhook: flags.isWebhook,
    isOwner: flags.userId === guild.ownerId,
    roleIds: member ? [...member.roles.cache.keys()] : [],
    hasStaffPermission: member?.permissions.any(staffPermissions) ?? false,
    botAdministratorRoleIds: [...profile.roles.botAdministrator],
    exemptRoleIds: profile.security.exemptRoleIds,
    can: {
      timeout: member?.moderatable ?? false,
      kick: member?.kickable ?? false,
      ban: member?.bannable ?? false,
    },
  };
}

export function messageSubject(message: Message<true>, member: GuildMember | null, profile: GuildConfiguration): TrapSubject {
  return subjectOf(member, profile, message.guild, {
    isBot: message.author.bot,
    isWebhook: message.webhookId !== null,
    userId: message.author.id,
  });
}

export function memberSubject(member: GuildMember, profile: GuildConfiguration): TrapSubject {
  return subjectOf(member, profile, member.guild, { isBot: member.user.bot, isWebhook: false, userId: member.id });
}

export interface Response {
  action: TrapAction;
  deleteWindow: TrapDeleteWindow;
  timeout: TrapTimeoutDuration;
}

export interface EnforcementOutcome {
  // "blocked": the member was fair game but the bot couldn't touch them.
  outcome: "acted" | "blocked" | "error";
  // How many of the member's other messages were removed.
  removed: number;
}

// What every security feature does once it has decided to act: remove the
// messages, deal with the member, sweep up after them, and say so in the log.
// Deciding who is fair game is each feature's own call (decideTrapResponse);
// this only carries the decision out.
export class SecurityEnforcer {
  public constructor(
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  public async respond(input: {
    member: GuildMember;
    response: Response;
    // The decision was "blocked": the bot can't act, so only clean up.
    blocked?: boolean;
    // When the offending message was posted, so a sweep starts from then.
    at: number;
    // Messages already known to belong to the offence, removed first.
    tracked?: readonly TrackedPost[];
  }): Promise<EnforcementOutcome> {
    const { member, response, at } = input;
    await this.deleteTracked(member.guild, input.tracked ?? []);
    if (input.blocked) return { outcome: "blocked", removed: 0 };

    try {
      await this.act(member, response);
    } catch (error) {
      this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Unable to act on a member");
      return { outcome: "error", removed: 0 };
    }
    // A ban already had Discord remove the messages.
    const removed = response.action === "ban" ? 0 : await this.sweep(member.guild, member.id, response.deleteWindow, at);
    return { outcome: "acted", removed };
  }

  private async act(member: GuildMember, response: Response): Promise<void> {
    const reason = "Security: automatic action";
    if (response.action === "ban") {
      // Discord deletes the banned member's recent messages itself.
      await member.guild.members.ban(member, { reason, deleteMessageSeconds: trapDeleteWindowSeconds[response.deleteWindow] });
    } else if (response.action === "kick") {
      await member.kick(reason);
    } else {
      await member.timeout(trapTimeoutMilliseconds[response.timeout], reason);
    }
  }

  private async deleteTracked(guild: Guild, tracked: readonly TrackedPost[]): Promise<void> {
    await Promise.all(tracked.map(async (post) => {
      const channel = guild.channels.cache.get(post.channelId);
      if (!channel?.isTextBased() || !("messages" in channel)) return;
      await channel.messages.delete(post.messageId).catch(() => undefined);
    }));
  }

  // Removes the member's messages from the last deleteWindow, across every
  // channel the bot can see and manage. Returns how many were removed.
  public async sweep(guild: Guild, userId: string, deleteWindow: TrapDeleteWindow, at: number): Promise<number> {
    const seconds = trapDeleteWindowSeconds[deleteWindow];
    if (seconds === 0) return 0;
    const since = Math.min(at, this.now()) - seconds * 1_000;
    const me = guild.members.me;
    if (!me) return 0;

    const channels = [...guild.channels.cache.values()]
      .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      .filter((channel) => channel.permissionsFor(me).has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ]))
      .slice(0, maxSweptChannels);

    let removed = 0;
    const queue = [...channels];
    const worker = async (): Promise<void> => {
      for (let channel = queue.shift(); channel; channel = queue.shift()) {
        try {
          const recent = await channel.messages.fetch({ limit: sweepFetchLimit });
          const mine = [...recent.values()].filter((entry) => entry.author.id === userId && entry.createdTimestamp >= since);
          if (mine.length === 0) continue;
          // bulkDelete refuses a single message and anything older than two
          // weeks (filtered out), so one goes through delete().
          if (mine.length === 1) await mine[0]?.delete();
          else await channel.bulkDelete(mine, true);
          removed += mine.length;
        } catch (error) {
          this.logger.warn({ error, guildId: guild.id, channelId: channel.id }, "Unable to sweep a channel for a member's messages");
        }
      }
    };
    await Promise.all(Array.from({ length: sweepConcurrency }, worker));
    return removed;
  }

  // One line in the guild's security log (or audit log when none is set).
  public async report(profile: GuildConfiguration, guild: Guild, description: string): Promise<void> {
    const channelId = profile.security.logChannelId ?? profile.channels.auditLog;
    if (!channelId) return;
    try {
      const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setColor(profile.embedColor as `#${string}`)
        .setDescription(description)
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      this.logger.warn({ error, guildId: profile.guildId, channelId }, "Unable to write a security log entry");
    }
  }
}
