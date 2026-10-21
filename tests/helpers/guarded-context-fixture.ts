import { vi } from "vitest";
import type { ChannelHistoryMessage, ChatUser } from "../../src/application/chat/chat-provider.js";
import type { GuardedContextPort, GuardedContextSource } from "../../src/application/chat/guarded-conversation-context.js";
import { registerConversationSource } from "../../src/application/context/conversation-source-registry.js";

export function guardedEvent(id: string, timestampMs: number, content: string, authorId = "alice", extra: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return { messageId: id, channelId: "channel", authorId, authorDisplayName: authorId, timestampMs, content, imageCount: 0,
    author: { id: authorId, displayName: authorId, roleNames: [], kind: authorId === "bot" ? "bot" : "human" }, ...extra };
}
export function guardedFixture(current = guardedEvent("current", 4000, "@bot"), scope = { guildId: "guild", channelId: "channel" }): {
  port: GuardedContextPort; sources: Map<string, GuardedContextSource>; denied: Set<string>; actors: Map<string, ChatUser>;
  setPolicy: (allowed: boolean) => void; add: (event: ChannelHistoryMessage) => void;
} {
  const sources = new Map<string, GuardedContextSource>(); const denied = new Set<string>(); let policy = true;
  const actors = new Map<string, ChatUser>([["alice", { id: "alice", displayName: "alice", roleNames: [], kind: "human" }]]);
  const add = (event: ChannelHistoryMessage): void => { sources.set(event.messageId, { event: { ...event, channelId: scope.channelId }, origin: "human", provenance: null }); };
  add(current);
  const port: GuardedContextPort = { ...scope, sourceMessageId: current.messageId, actorId: current.authorId,
    policyCurrent: () => policy,
    read: vi.fn((id: string) => Promise.resolve(denied.has(id) ? null : structuredClone(sources.get(id) ?? null))),
    page: vi.fn((before: string | null) => {
      const time = before ? sources.get(before)?.event.timestampMs ?? Infinity : Infinity;
      return Promise.resolve([...sources.values()].map((source) => source.event).filter((event) => event.timestampMs < time)
        .sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 100).map((event) => event.messageId));
    }),
    actor: vi.fn((id: string) => Promise.resolve(structuredClone(actors.get(id) ?? null))),
  };
  return { sources, denied, actors, port: registerConversationSource(port), setPolicy: (allowed): void => { policy = allowed; }, add };
}
