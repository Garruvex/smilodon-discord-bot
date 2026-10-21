import type { DecisionOutcome } from "./character-decision.js";
import type { ChatRequest } from "./chat-provider.js";
import type { ContextualReplayCase } from "./contextual-replay.js";
import { ConversationDecisionEngine } from "./conversation-decision-engine.js";
import { GuardedConversationContext, type GuardedContextPort, type GuardedContextSource } from "./guarded-conversation-context.js";
import { defaultParticipation } from "./participation-policy.js";

export const contextualReplayPolicyRevision = 3;
// Synthetic, in-memory authorization premise. Exercise the real registered
// lease and policy engine; do not impersonate a lease or connect to Discord.
export async function replayPolicyAssessment(fixture: ContextualReplayCase, outcome: DecisionOutcome): Promise<{
  status: string; action: string; reason: string; textPolicyMet: boolean; requiredReplyMet: boolean;
}> {
  const guildId = "synthetic-guild"; const channelId = "synthetic-channel"; const botId = "1000000000000000200";
  const sources = new Map<string, GuardedContextSource>();
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
      const prior = await GuardedConversationContext.open({ ...port, sourceMessageId: human.messageId, actorId: human.authorId }, { count: 40, budget: 12000, burstIds: [] });
      sources.set(event.messageId, { event, origin: "chat", provenance: prior.provenance(event.content) });
    } else sources.set(event.messageId, { event, origin: "human", provenance: null });
  }
  const lease = await GuardedConversationContext.open(port, { count: 40, budget: 12000, burstIds: [fixture.current.messageId] });
  if (!await lease.validate()) throw new Error("Synthetic lease validation failed");
  const request: ChatRequest = { guildId, channelId, personality: "Synthetic evaluation", personaLore: [], personaDrift: null, exampleExchanges: [], userCustomization: null,
    currentUser: { id: fixture.current.authorId, displayName: fixture.current.authorDisplayName, roleNames: [] }, mentionedUsers: [], recentHistory: [],
    memories: [], guildKnowledge: [], causalChains: [], message: lease.current.content, replyChain: lease.replyChain, replyChainSummary: null,
    channelHistory: lease.history, currentBurst: lease.burst, ...(lease.currentEvent ? { currentEvent: lease.currentEvent } : {}), contextLease: lease, birthday: null, images: [],
    webSearchMode: "off", imageGenerationEnabled: false, includeSources: false, triggerMode: "spontaneous", botUserId: botId,
    turnPlan: { state: "ready", flow: "contextual_v1", context: "guarded_text", decision: "contextual", deadlineMs: 30000, contextPolicy: { count: 40, budget: 12000 } },
    optionalActionsAvailable: { text: true, reaction: true } };
  const result = new ConversationDecisionEngine().assess(request, outcome, { ...defaultParticipation, continuationEnabled: true,
    spontaneousEnabled: true, spontaneousChannelIds: [channelId] }, true, fixture.current.timestampMs + 1, "synthetic-policy").result;
  const requiresReply = fixture.scenario === "repair" || fixture.scenario === "correction" || fixture.scenario === "answer" && !fixture.id.endsWith("-other");
  return { status: result.status, action: result.decision.action, reason: result.decision.reasonCode,
    textPolicyMet: fixture.textAllowed || result.decision.action !== "reply", requiredReplyMet: !requiresReply || result.decision.action === "reply" };
}
