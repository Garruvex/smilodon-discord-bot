import { PermissionFlagsBits, type Client, type TextChannel, type GuildMember, type Message } from "discord.js";
import { mapWithConcurrency } from "../../../application/concurrency/map-with-concurrency.js";
import type { SocialChatEligibility } from "../behaviors/social-chat-eligibility.js";

import type {
  ChannelHistoryMessage,
  ChannelHistoryReadRequest,
  ChannelHistoryReadResult,
  ChannelHistoryReader,
} from "../../../application/context/channel-history-reader.js";

const fetchPageSize = 100;

export class DiscordChannelHistoryReader implements ChannelHistoryReader {
  public constructor(private readonly client: Client, private readonly eligibility: SocialChatEligibility | null = null) {}

  public async validateBatch(messages: readonly ChannelHistoryMessage[], signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const first = messages[0];
    if (!first || messages.length > 500 || !this.eligibility?.canReadBackground(first.guildId, first.channelId) ||
        messages.some((source) => source.guildId !== first.guildId || source.channelId !== first.channelId)) return false;
    const channel = await this.client.channels.fetch(first.channelId, { force: true }).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== first.guildId) return false;
    const me = await channel.guild.members.fetchMe({ force: true }).catch(() => null);
    const permissions = me ? channel.permissionsFor(me) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) return false;
    const fresh = new Map<string, Message>();
    // Dense batches need only a few page reads. Sparse batches get bounded
    // exact-ID reads instead of an unbounded scan through unrelated history.
    if (messages.every((source) => /^\d+$/u.test(source.id))) {
      let before = (messages.reduce((maximum, source) => BigInt(source.id) > maximum ? BigInt(source.id) : maximum, 0n) + 1n).toString();
      for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
        signal?.throwIfAborted();
        const page = await channel.messages.fetch({ before, limit: 100, cache: false }).catch(() => null);
        if (!page?.size) break;
        for (const message of page.values()) fresh.set(message.id, message);
        if (messages.every((source) => fresh.has(source.id)) || page.size < 100) break;
        const oldest = page.last()?.id; if (!oldest || oldest === before) break; before = oldest;
      }
    }
    const missing = messages.filter((source) => !fresh.has(source.id));
    if (missing.length > 16) return false;
    await mapWithConcurrency(missing, 4, async (source) => {
      signal?.throwIfAborted();
      const message = await channel.messages.fetch({ message: source.id, force: true, cache: false }).catch(() => null);
      if (message) fresh.set(source.id, message);
    });
    const members = new Map<string, GuildMember>();
    await mapWithConcurrency([...new Set(messages.map((source) => source.authorId))], 4, async (user) => {
      signal?.throwIfAborted();
      const member = await channel.guild.members.fetch({ user, force: true, cache: false }).catch(() => null);
      if (member) members.set(user, member);
    });
    for (const source of messages) {
      signal?.throwIfAborted();
      const message = fresh.get(source.id); const member = members.get(source.authorId);
      if (!message || !member || message.author.bot || message.system || message.author.id !== source.authorId ||
          message.createdTimestamp !== source.createdAt || message.content.trim().slice(0, source.content.length) !== source.content ||
          member.displayName !== source.authorDisplayName || !(await this.eligibility.checkBackgroundSource(message, member)).eligible) return false;
    }
    return this.eligibility.canReadBackground(first.guildId, first.channelId);
  }

  public async canLearn(guildId: string, channelId: string, sourceMessageId: string): Promise<boolean> {
    if (this.eligibility && !this.eligibility.canReadBackground(guildId, channelId)) return false;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) return false;
    const message = await channel.messages.fetch(sourceMessageId).catch(() => null);
    return Boolean(message && !message.author.bot && (!this.eligibility || (await this.eligibility.checkBackgroundSource(message)).eligible));
  }

  public async readBatch(request: ChannelHistoryReadRequest): Promise<ChannelHistoryReadResult> {
    if (this.eligibility && !this.eligibility.canReadBackground(request.guildId, request.channelId))
      return { ok: false, code: "scope_denied", message: "The channel is no longer selected for history scans or daily summaries." };
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
        if (this.eligibility && !this.eligibility.canReadBackground(request.guildId, request.channelId))
          return { ok: false, code: "scope_denied", message: "Background reading scope changed during the scan." };
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
          const eligible = !message.author.bot && !message.system && content.length > 0 &&
            (!this.eligibility || (await this.eligibility.checkBackgroundSource(message)).eligible);
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
