import type { ContextualReplayCase } from "./contextual-replay.js";
import { GuardedConversationContext, type GuardedContextPort, type GuardedContextSource } from "./guarded-conversation-context.js";
import { registerConversationSource } from "../context/conversation-source-registry.js";

// Offline synthetic authorization premise only. Never use this port for live
// Discord data. Bot text gets real registered provenance from its seed source.
export async function syntheticReplayContext(fixture: ContextualReplayCase, guildId = "synthetic-guild", channelId = "synthetic-channel"): Promise<{
  port: GuardedContextPort; sources: Map<string, GuardedContextSource>; botId: string;
}> {
  const botId = "1000000000000000200"; const sources = new Map<string, GuardedContextSource>();
  const port: GuardedContextPort = { guildId, channelId, sourceMessageId: fixture.current.messageId, actorId: fixture.current.authorId,
    read: (id) => Promise.resolve(structuredClone(sources.get(id) ?? null)),
    page: (before) => Promise.resolve([...sources.values()].map((source) => source.event)
      .filter((event) => event.timestampMs < (before ? sources.get(before)?.event.timestampMs ?? Infinity : Infinity))
      .sort((a, b) => b.timestampMs - a.timestampMs).map((event) => event.messageId)),
    actor: () => Promise.resolve(null), policyCurrent: () => true };
  for (const original of [...fixture.events, fixture.current]) {
    const event = { ...original, channelId };
    if (event.authorId === botId) {
      const human = event.replyToMessageId ? sources.get(event.replyToMessageId)?.event : null;
      if (!human) throw new Error("Synthetic bot exchange requires an earlier human source");
      const prior = await GuardedConversationContext.open(registerConversationSource({ ...port, sourceMessageId: human.messageId, actorId: human.authorId }), { count: 40, budget: 12000, burstIds: [] });
      sources.set(event.messageId, { event, origin: "chat", provenance: prior.provenance(event.content) });
    } else sources.set(event.messageId, { event, origin: "human", provenance: null });
  }
  return { port: registerConversationSource(port), sources, botId };
}
