import type { ChannelHistoryMessage } from "./chat-provider.js";

export const episodeRetentionMs = 15 * 60_000;
export interface ConversationEpisodeStore {
  load(guildId: string, channelId: string, now: number): Promise<readonly ChannelHistoryMessage[]>;
  observe(guildId: string, channelId: string, event: ChannelHistoryMessage, now: number): Promise<void>;
  exclude(guildId: string, channelId: string, sourceMessageId: string): Promise<void>;
  deleteExpired(now: number): Promise<void>;
  forgetUser(guildId: string, userId: string): Promise<void>;
}

export function forgetEpisodeUser(events: readonly ChannelHistoryMessage[], userId: string): ChannelHistoryMessage[] {
  let kept = [...events];
  for (const event of events) if (event.authorId === userId || event.replyToAuthorId === userId)
    kept = excludeEpisodeInteraction(kept, event.messageId);
  return kept;
}

export function boundEpisodeEvents(events: readonly ChannelHistoryMessage[], now: number): ChannelHistoryMessage[] {
  let characters = 0;
  return [...new Map(events.filter((event) => event.timestampMs >= now - episodeRetentionMs)
    .map((event) => [event.messageId, { ...event, content: event.content.slice(0, 2000) }])).values()]
    .sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 48).filter((event) => {
      characters += JSON.stringify(event).length; return characters <= 16_000;
    }).reverse();
}

export function excludeEpisodeInteraction(events: readonly ChannelHistoryMessage[], sourceId: string): ChannelHistoryMessage[] {
  const excluded = new Set([sourceId]);
  for (let depth = 0; depth < 48; depth++) {
    const before = excluded.size;
    for (const event of events) if (event.replyToMessageId && excluded.has(event.replyToMessageId)) excluded.add(event.messageId);
    if (excluded.size === before) break;
  }
  return events.filter((event) => !excluded.has(event.messageId));
}
