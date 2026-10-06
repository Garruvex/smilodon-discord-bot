import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
} from "discord.js";
import type { Logger } from "pino";

import { texts } from "../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import {
  decideTrapResponse,
  trapDeleteWindowSeconds,
  trapTimeoutMilliseconds,
  type TrapAction,
  type TrapSubject,
} from "../../../domain/security/trap-policy.js";

const auditReason = "Posted in the security channel";

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

export function trapSubject(
  message: Message<true>,
  member: GuildMember | null,
  profile: GuildConfiguration,
): TrapSubject {
  return {
    isBot: message.author.bot,
    isWebhook: message.webhookId !== null,
    isOwner: message.author.id === message.guild.ownerId,
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

// Deals with a message posted in a guild's trap channel. The channel exists
// to catch compromised accounts and spam bots: nothing legitimate is ever
// posted there, so the sender is removed from play and their recent spam is
// cleaned up. Everything that could hit a real person (staff, the owner, bot
// admins, exempt roles, members the bot outranks) is decided in
// decideTrapResponse and refused there.
export class TrapService {
  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  // True when the message was in the trap channel and was dealt with, so
  // nothing else (chat, link fixing) should answer it.
  public async handle(message: Message<true>): Promise<boolean> {
    const profile = this.profiles.find(message.guildId);
    const trap = profile?.security.trap;
    if (!profile || !trap?.enabled || trap.channelId !== message.channelId) return false;

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const decision = decideTrapResponse(trapSubject(message, member, profile), trap);
    if (decision.kind === "skip") return false;

    // The message goes first: whatever happens next, the spam is gone.
    await message.delete().catch((error: unknown) => {
      this.logger.warn({ error, guildId: message.guildId, messageId: message.id }, "Unable to delete a trap channel message");
    });
    if (!member) return true;

    if (decision.kind === "blocked") {
      await this.report(profile, message, "blocked", decision.action, 0);
      return true;
    }

    try {
      await this.act(member, decision.action, profile);
    } catch (error) {
      this.logger.error({ error, guildId: message.guildId, userId: member.id }, "Unable to act on a trap channel poster");
      await this.report(profile, message, "error", decision.action, 0);
      return true;
    }
    const removed = decision.action === "ban" ? 0 : await this.sweep(member.guild, member.id, profile, message.createdTimestamp);
    await this.report(profile, message, "acted", decision.action, removed);
    return true;
  }

  private async act(member: GuildMember, action: TrapAction, profile: GuildConfiguration): Promise<void> {
    const { deleteWindow, timeout } = profile.security.trap;
    if (action === "ban") {
      // Discord deletes the banned member's recent messages itself.
      await member.guild.members.ban(member, { reason: auditReason, deleteMessageSeconds: trapDeleteWindowSeconds[deleteWindow] });
    } else if (action === "kick") {
      await member.kick(auditReason);
    } else {
      await member.timeout(trapTimeoutMilliseconds[timeout], auditReason);
    }
  }

  // Removes the member's messages from the last deleteWindow, across every
  // channel the bot can see and manage. Returns how many were removed.
  private async sweep(guild: Guild, userId: string, profile: GuildConfiguration, at: number): Promise<number> {
    const seconds = trapDeleteWindowSeconds[profile.security.trap.deleteWindow];
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
          this.logger.warn({ error, guildId: guild.id, channelId: channel.id }, "Unable to sweep a channel for a trap poster's messages");
        }
      }
    };
    await Promise.all(Array.from({ length: sweepConcurrency }, worker));
    return removed;
  }

  private async report(
    profile: GuildConfiguration,
    message: Message<true>,
    outcome: "acted" | "blocked" | "error",
    action: TrapAction,
    removed: number,
  ): Promise<void> {
    const channelId = profile.security.logChannelId ?? profile.channels.auditLog;
    if (!channelId) return;
    try {
      const channel = message.guild.channels.cache.get(channelId) ?? await message.guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const log = texts[profile.language].security.trap.log;
      const params = {
        user: `<@${message.author.id}>`,
        channel: `<#${message.channelId}>`,
        action: texts[profile.language].security.trap.action[action],
        removed,
      };
      const embed = new EmbedBuilder()
        .setColor(profile.embedColor as `#${string}`)
        .setDescription(log[outcome](params))
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      this.logger.warn({ error, guildId: profile.guildId, channelId }, "Unable to write a security log entry");
    }
  }
}
