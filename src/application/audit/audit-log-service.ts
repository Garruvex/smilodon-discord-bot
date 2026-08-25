import { ChannelType, EmbedBuilder, type Client } from "discord.js";
import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";

export interface AuditLogEntrySummary {
  description: string;
  createdAt: number;
}

export interface AuditLogFetchResult {
  configured: boolean;
  entries: readonly AuditLogEntrySummary[];
}

// Writes a short embed to a guild's configured audit-log channel when an
// admin makes a change through the bot (settings updates, setup runs). A
// no-op whenever the guild has no `channels.auditLog` configured.
export class AuditLogService {
  public constructor(
    private readonly client: Client,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly logger: Logger,
  ) {}

  public async log(guildId: string, actorUserId: string, summary: string): Promise<void> {
    const profile = this.guildConfigurationProvider.find(guildId);
    const channelId = profile?.channels.auditLog;
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      // client.channels.fetch is global, not guild-scoped — without the
      // guildId check a stale/misconfigured channels.auditLog id (left over
      // from a deleted channel, or copy-pasted from another guild's config)
      // could resolve to a channel in a different guild and write this
      // guild's admin-action log — including the acting user's mention —
      // into it.
      if (
        !channel?.isTextBased() ||
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM ||
        channel.guildId !== guildId
      ) {
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(profile.embedColor as `#${string}`)
        .setDescription(`**<@${actorUserId}>**\n${summary}`)
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      this.logger.warn({ error, guildId, channelId }, "Unable to write audit log entry");
    }
  }

  // Reads back the most recent entries directly from Discord (the channel is
  // the only store — there's no separate database table to query), for a
  // `/settings audit` view command.
  public async fetchRecent(guildId: string, limit: number): Promise<AuditLogFetchResult> {
    const profile = this.guildConfigurationProvider.find(guildId);
    const channelId = profile?.channels.auditLog;
    if (!channelId) return { configured: false, entries: [] };

    try {
      const channel = await this.client.channels.fetch(channelId);
      // Same cross-guild concern as log() above: without the guildId check,
      // a stale/misconfigured channels.auditLog id could read back another
      // guild's channel messages and present them to this guild's admins as
      // "this guild's audit history" — an unauthenticated read from
      // whatever channel that id happens to resolve to.
      if (
        !channel?.isTextBased() ||
        channel.type === ChannelType.DM ||
        channel.type === ChannelType.GroupDM ||
        channel.guildId !== guildId
      ) {
        return { configured: true, entries: [] };
      }
      const messages = await channel.messages.fetch({ limit });
      const entries = [...messages.values()]
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .map((message) => ({
          description: message.embeds[0]?.description ?? message.content ?? "(no content)",
          createdAt: message.createdTimestamp,
        }));
      return { configured: true, entries };
    } catch (error) {
      this.logger.warn({ error, guildId, channelId }, "Unable to fetch recent audit log entries");
      return { configured: true, entries: [] };
    }
  }
}
