import { exchangeIdleMs } from "./exchange-window.js";
import type { ChannelHistoryMessage } from "./chat-provider.js";
import { forgetEpisodeUser } from "./conversation-episode-store.js";

// Short-lived observations, separate from durable facts. Channel/thread
// keys never merge across audiences; explicit reply links preserve branches.
export class ConversationEpisodes {
  private readonly channels = new Map<string, ChannelHistoryMessage[]>();
  private readonly excluded = new Map<string, Set<string>>();
  private readonly versions = new Map<string, number>();
  public observe(key: string, event: ChannelHistoryMessage, now = Date.now(), retentionMs = 900_000): void {
    const excluded = this.excluded.get(key);
    if (excluded?.has(event.messageId) || event.replyToMessageId && excluded?.has(event.replyToMessageId)) {
      excluded?.add(event.messageId); return;
    }
    const previous = this.channels.get(key)?.find((item) => item.messageId === event.messageId);
    if (!previous || JSON.stringify([previous.content, previous.imageCount, previous.replyToMessageId, previous.authorId]) !== JSON.stringify([event.content, event.imageCount, event.replyToMessageId, event.authorId])) this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    const events = (this.channels.get(key) ?? []).filter((item) => item.messageId !== event.messageId && item.timestampMs >= now - retentionMs);
    events.push(event);
    if (this.channels.size >= 256 && !this.channels.has(key)) {
      const oldest = this.channels.keys().next().value!;
      this.channels.delete(oldest); this.versions.delete(oldest); this.excluded.delete(oldest);
    }
    this.channels.set(key, events.slice(-48));
  }
  public version(key: string): number { return this.versions.get(key) ?? 0; }
  public windowSnapshot(key: string, minutes: number, now = Date.now()): ChannelHistoryMessage[] {
    return (this.channels.get(key) ?? []).filter((event) => event.timestampMs >= now - minutes * 60_000).slice(-48);
  }
  public snapshot(key: string, authorId: string, targetId: string | null, now = Date.now()): ChannelHistoryMessage[] {
    const events = (this.channels.get(key) ?? []).filter((item) => item.timestampMs >= now - 900_000);
    const branch = new Set<string>(targetId ? [targetId] : []);
    for (let iteration = 0; iteration < 4; iteration++) {
      for (const event of events) {
        if (branch.has(event.messageId) && event.replyToMessageId) branch.add(event.replyToMessageId);
        if (event.replyToMessageId && branch.has(event.replyToMessageId)) branch.add(event.messageId);
      }
    }
    const relevant = targetId ? events.filter((event) => branch.has(event.messageId))
      : events.filter((event) => event.authorId === authorId || event.replyToAuthorId === authorId);
    const chosen = new Map([...events.slice(-8), ...relevant.slice(-12)].map((event) => [event.messageId, event]));
    let chars = 0;
    return [...chosen.values()].sort((a, b) => b.timestampMs - a.timestampMs).filter((event) => {
      chars += event.content.length; return chars <= 8_000;
    }).slice(0, 16).reverse();
  }
  public hasRecentConversation(key: string, authorId: string, botId: string, now = Date.now()): boolean {
    return (this.channels.get(key) ?? []).some((event) => event.authorId === botId && event.replyToAuthorId === authorId && now - event.timestampMs <= exchangeIdleMs);
  }
  public forget(guildId: string, userId: string): void {
    for (const [key, events] of this.channels) {
      if (key.startsWith(`${guildId}:`)) {
        this.channels.set(key, forgetEpisodeUser(events, userId));
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
      }
    }
  }

  public excludeInteraction(key: string, sourceId: string): void {
    const events = this.channels.get(key) ?? [];
    const excluded = new Set([sourceId]);
    for (let depth = 0; depth < 48; depth++) {
      const before = excluded.size;
      for (const event of events) if (event.replyToMessageId && excluded.has(event.replyToMessageId)) excluded.add(event.messageId);
      if (excluded.size === before) break;
    }
    const tombstones = this.excluded.get(key) ?? new Set<string>();
    excluded.forEach((id) => tombstones.add(id));
    while (tombstones.size > 512) tombstones.delete(tombstones.values().next().value!);
    if (this.excluded.size >= 256 && !this.excluded.has(key)) this.excluded.delete(this.excluded.keys().next().value!);
    this.excluded.set(key, tombstones);
    this.channels.set(key, events.filter((event) => !excluded.has(event.messageId)));
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}
