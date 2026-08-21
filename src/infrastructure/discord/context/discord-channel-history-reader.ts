import { PermissionFlagsBits, type Client, type TextChannel } from "discord.js";

import type {
  ChannelHistoryMessage,
  ChannelHistoryReadRequest,
  ChannelHistoryReadResult,
  ChannelHistoryReader,
} from "../../../application/context/channel-history-reader.js";

const fetchPageSize = 100;

export class DiscordChannelHistoryReader implements ChannelHistoryReader {
  public constructor(private readonly client: Client) {}

  public async readBatch(request: ChannelHistoryReadRequest): Promise<ChannelHistoryReadResult> {
    const channel = await this.client.channels.fetch(request.channelId).catch(() => null);
    if (!channel) {
      return { ok: false, code: "channel_not_found", message: "The configured channel was not found or is inaccessible." };
    }
    if (!channel.isTextBased() || channel.isDMBased()) {
      return { ok: false, code: "unsupported_channel", message: "The configured channel is not a guild text channel." };
    }
    if (channel.guild.id !== request.guildId) {
      return { ok: false, code: "guild_mismatch", message: "The configured channel belongs to a different server." };
    }

    const me = channel.guild.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
      return { ok: false, code: "missing_view_permission", message: "The bot is missing View Channel permission." };
    }
    if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
      return { ok: false, code: "missing_history_permission", message: "The bot is missing Read Message History permission." };
    }

    return this.fetchMessages(channel as TextChannel, request);
  }

  private async fetchMessages(
    channel: TextChannel,
    request: ChannelHistoryReadRequest,
  ): Promise<ChannelHistoryReadResult> {
    const messages: ChannelHistoryMessage[] = [];
    let before = request.beforeMessageId ?? undefined;
    let oldestSeenMessageId: string | null = null;
    let reachedBoundary = false;
    let characters = 0;

    try {
      while (messages.length < request.maxMessages && characters < request.maxCharacters) {
        const page = await channel.messages.fetch({ limit: fetchPageSize, ...(before ? { before } : {}) });
        if (page.size === 0) {
          reachedBoundary = true;
          break;
        }

        let stoppedForLimit = false;
        for (const message of page.values()) {
          if (message.createdTimestamp < request.boundaryMs) {
            reachedBoundary = true;
            break;
          }

          const content = message.content.trim().slice(0, request.maxCharactersPerMessage);
          const eligible = !message.author.bot && !message.system && content.length > 0;
          // Don't advance the cursor past a message we're deferring to the
          // next batch — only past ones we've fully consumed (pushed, or
          // permanently skipped as ineligible). Advancing on every message
          // regardless would let the cap cut off mid-page and silently drop
          // the message that tripped it forever, since the next tick's
          // `before` cursor excludes it going forward.
          if (eligible && (messages.length >= request.maxMessages || characters + content.length > request.maxCharacters)) {
            stoppedForLimit = true;
            break;
          }

          oldestSeenMessageId = message.id;
          if (!eligible) continue;

          messages.push({
            id: message.id,
            guildId: request.guildId,
            channelId: request.channelId,
            authorId: message.author.id,
            authorDisplayName: message.member?.displayName ?? message.author.username,
            content,
            createdAt: message.createdTimestamp,
          });
          characters += content.length;
        }

        if (reachedBoundary || stoppedForLimit || page.size < fetchPageSize) {
          if (!stoppedForLimit) reachedBoundary = true;
          break;
        }
        before = page.last()?.id;
      }
    } catch (error) {
      return {
        ok: false,
        code: "fetch_failed",
        message: error instanceof Error ? error.message : "Channel history fetch failed.",
      };
    }

    return { ok: true, messages, oldestSeenMessageId, reachedBoundary };
  }
}
