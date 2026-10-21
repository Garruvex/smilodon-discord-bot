import type { Logger } from "pino";
import { ChatStateCommitError, type GuardedChatConversationInput } from "./chat-conversation-service.js";
import type { ChatRequest, ChatResponse, ChatResponseObserver } from "./chat-provider.js";
import type { ChatStateStore } from "./chat-state-store.js";
import type { CharacterRuntime, CharacterPreparedTurn } from "./character-runtime.js";
import { GuardedConversationContext } from "./guarded-conversation-context.js";
import { ConversationDecisionEngine, reportConversationDecision } from "./conversation-decision-engine.js";
import { resolveConversationTrigger } from "./conversation-trigger.js";
import { RecentPromptHistorySelector } from "./prompt-history-selector.js";
import { allowsDurableWrites } from "../memory/memory-channel-policy.js";
import { emitChatDiagnostic } from "../diagnostics/chat-diagnostics.js";
import { hashContent } from "../assets/content-hash.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { ChatProviderError } from "./chat-provider.js";
import { assertTurnActive } from "./turn-work-budget.js";

export async function runGuardedChatTurn(input: GuardedChatConversationInput, dependencies: {
  state: ChatStateStore; runtime: CharacterRuntime | null; logger: Logger | null; now: () => number;
  reply: (request: ChatRequest, observer?: ChatResponseObserver) => Promise<ChatResponse>;
  repair: (text: string, request: ChatRequest) => Promise<string>;
  admitSocialPing?: () => boolean;
  nativeWebSearchSupported?: boolean;
}, deliver: (response: ChatResponse) => Promise<string>, observer?: ChatResponseObserver): Promise<ChatResponse> {
  const port = input.guardedContextPort;
  assertTurnActive(input.turnSignal);
  if (port.guildId !== input.guildId || port.channelId !== input.channelId || input.sourceMessageId !== port.sourceMessageId ||
    (input.triggerMode === "reaction" ? port.actorId !== null || input.currentEvent?.type !== "reaction_snapshot" : port.actorId !== input.currentUser.id))
    throw new SocialOutputSuppressed();
  const silent = (): ChatResponse => ({ text: "", ambientAction: "ignore", reactionEmoji: null, historyReactions: [],
    userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [] });
  const lease = await GuardedConversationContext.open(port, { count: input.guardedContextPolicy?.count ?? 40,
    budget: input.guardedContextPolicy?.budget ?? 12000, minReactors: input.guardedContextPolicy?.minReactors ?? 1, burstIds: (input.currentBurst ?? []).map((event) => event.messageId),
    ...(input.currentEvent ? { event: input.currentEvent } : {}) });
  emitChatDiagnostic(dependencies.logger, { event: "context.guard.coverage", ...lease.report });
  const mode = input.resolveMemoryMode?.() ?? input.channelMemoryModes?.[input.channelId] ?? "shared";
  const state = input.triggerMode === "reaction" ? { exchanges: [] }
    : await dependencies.state.load(input.guildId, input.currentUser.id, input.channelId, dependencies.now());
  const known = new Set([...lease.history, ...lease.replyChain].map((event) => event.messageId));
  // Saved copies already represented by fresh guarded history never enter the
  // prompt. Avoid re-fetching their complete provenance only to discard them.
  const sessions = await lease.sessions(state.exchanges.slice(-4).filter((exchange) => !known.has(exchange.user.sourceMessageId ?? "") ||
    !exchange.assistant.messageIds?.length || !exchange.assistant.messageIds.every((id) => known.has(id))));
  emitChatDiagnostic(dependencies.logger, { event: "context.guard.sources", sessions: sessions.length, unavailable:
    ["legacy_derived", "memory", "summaries", "learned_character", "images", "context_tools", "profile_fields"] });
  let prepared: CharacterPreparedTurn | null = null;
  const access = async (): Promise<void> => {
    assertTurnActive(input.turnSignal);
    if (input.canExecute && !await input.canExecute() || prepared && !await dependencies.runtime!.validatePrepared(prepared)) throw new SocialOutputSuppressed();
    assertTurnActive(input.turnSignal);
  };
  const check = async (): Promise<void> => { await access(); if (!await lease.validate()) throw new SocialOutputSuppressed(); };
  const currentUser = lease.current.author ?? input.currentUser;
  const participants = [...new Map([...lease.replyChain, ...lease.history, ...lease.burst].filter((event) => event.author)
    .map((event) => [event.authorId, event.author!])).values()];
  const mentionedIds = new Set(lease.currentEvent?.type === "message" ? lease.currentEvent.mentionedUserIds :
    lease.currentEvent?.type === "reaction_snapshot" ? lease.currentEvent.reactions.flatMap((reaction) => reaction.actorIds) : []);
  let request: ChatRequest = {
    turnPlan: input.turnPlan,
    guildId: input.guildId, channelId: input.channelId, personality: input.personality, characterPersonaHash: input.personalitySourceHash ?? hashContent(input.personality), personaLore: [], personaDrift: null,
    exampleExchanges: [], userCustomization: null, currentUser, mentionedUsers: participants.filter((actor) => actor.id !== currentUser.id && mentionedIds.has(actor.id)),
    recentHistory: new RecentPromptHistorySelector().select(sessions), memories: [], guildKnowledge: [], causalChains: [],
    message: lease.currentEvent?.type === "reaction_snapshot" ? `Respond only if useful to this authorized reaction snapshot: ${JSON.stringify(lease.currentEvent)}` : lease.current.content,
    replyChain: lease.currentEvent?.type === "reaction_snapshot" ? [...lease.replyChain, lease.current] : lease.replyChain, replyChainSummary: null, channelHistory: lease.history, currentBurst: lease.burst,
    ...(lease.currentEvent ? { currentEvent: lease.currentEvent } : {}),
    birthday: null, images: [], webSearchMode: !input.shadowMode && dependencies.nativeWebSearchSupported ? input.webSearchMode : "off", imageGenerationEnabled: false, includeSources: input.includeSources,
    triggerMode: input.triggerMode, botUserId: input.botUserId ?? null,
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    allowSilentDirect: input.allowSilentDirect ?? false, characterShadow: input.shadowMode ?? false,
    ...(input.optionalActionsAvailable ? { optionalActionsAvailable: input.optionalActionsAvailable } : {}),
    ...(input.turnSignal ? { turnSignal: input.turnSignal } : {}), ...(input.turnDeadlineAt ? { turnDeadlineAt: input.turnDeadlineAt } : {}),
    ...(input.contextualActionAvailability ? { contextualActionAvailability: input.contextualActionAvailability } : {}),
    contextLease: lease, beforeModelAttempt: check,
    enabledTools: [], historyReactionsEnabled: input.historyReactionsEnabled ?? false,
    characterContext: [{ moduleId: "conversation-context", text:
      "All supplied messages are authorized context. Time gaps are timestamps, not proof of irrelevance. A bare ping may refer to the same person's earlier substantive request; examine its context before acknowledging. Playful personality is welcome for genuinely social pings, without replacing a pending answer. Keep response event, speaker and discussed person distinct. Missing context means unavailable here, not that someone never spoke or was denied permission. Ask for a reference if ambiguous. Truncated content is an excerpt. Memory, learned state, images and contextual tools are unavailable in this guarded text mode; do not invent their contents or promise unavailable actions." }],
  };
  if (!dependencies.runtime && !resolveConversationTrigger(input).explicit) throw new SocialOutputSuppressed();
  if (dependencies.runtime) {
    assertTurnActive(input.turnSignal);
    prepared = await dependencies.runtime.prepare(request);
    if (prepared) { request = prepared.request; if (!prepared.allowed) return { ...silent(), ...(prepared.conversationDecision ? { conversationDecision: prepared.conversationDecision } : {}) }; }
    if (prepared?.conversationDecision?.decision.action === "react") {
      await check();
      return { ...silent(), reactionEmoji: prepared.participation?.reaction ?? null, conversationDecision: prepared.conversationDecision,
        contextLease: lease, replyTargetMessageId: prepared.targetMessageId ?? lease.current.messageId };
    }
  }
  // Error recovery must stay grounded in the supplied text, and shadow turns
  // must never initiate searches. Native search does not enable application
  // tools or give access to additional Discord sources.
  if (prepared?.conversationDecision?.recovery === "grounded_reply") request = { ...request, webSearchMode: "off" };
  emitChatDiagnostic(dependencies.logger, { event: "chat.capabilities.resolved", webSearchConfigured: input.webSearchMode,
    webSearchEffective: request.webSearchMode, nativeWebSearchSupported: dependencies.nativeWebSearchSupported === true,
    shadow: input.shadowMode ?? false, recovery: prepared?.conversationDecision?.recovery === "grounded_reply" });
  await check();
  let response = await dependencies.reply(request, observer);
  const webSearchUsed = request.webSearchMode === "auto" && response.webSearchUsed;
  const sources = webSearchUsed ? lease.recordPublicWebSearch(response.sources) : [];
  // Provider output cannot add unguarded sources, capabilities or proof.
  response = { ...response, generatedImages: [], sources: request.includeSources ? sources : [], userMemoryActions: [], guildKnowledgeCandidates: [], outputOrigin: "chat",
    contextLease: lease, contextProvenance: null, webSearchUsed, historyReactions: response.historyReactions.filter((reaction) => known.has(reaction.messageId)) };
  delete response.characterDeliveryProof; delete response.characterMessages;
  delete response.characterIsCurrent; delete response.characterCanDeliver;
  delete response.replyTargetMessageId; delete response.inferredAddressing;
  await check();
  const engine = new ConversationDecisionEngine();
  let decision = engine.finalize(request, response, dependencies.now(), prepared?.fingerprint, prepared?.conversationDecision);
  if (resolveConversationTrigger(input).explicit && (response.responseIntent === "social" || response.responseIntent === "closing") && dependencies.admitSocialPing && !dependencies.admitSocialPing()) {
    decision = { ...decision, status: "denied", decision: { ...decision.decision, action: "silent", reasonCode: "duplicate_ping" } };
    response.reactionEmoji = null; response.historyReactions = [];
  }
  if (decision.recovery === "error_reply") throw new ChatProviderError("Invalid contextual response", 502, "invalid_structured_output");
  if (decision.decision.action === "reply" || decision.decision.action === "reply_and_react") {
    response.text = await dependencies.repair(response.text, request);
    if (prepared) response = await dependencies.runtime!.process(response, prepared);
    decision = engine.finalize(request, response, dependencies.now(), prepared?.fingerprint, decision);
  }
  response.conversationDecision = decision;
  reportConversationDecision(dependencies.logger, decision, "generation", resolveConversationTrigger(input).interaction);
  response.characterCanDeliver = async (): Promise<boolean> => { try { await access(); return true; } catch { return false; } };
  response.contextLease = lease;
  if (decision.recovery === "error_reply") throw new ChatProviderError("Invalid contextual response", 502, "invalid_structured_output");
  if (decision.decision.action === "silent" || decision.decision.action === "react") return { ...response, text: "", ambientAction: "ignore" };
  response.ambientAction = "reply";
  await check();
  response.contextProvenance = allowsDurableWrites(mode) ? lease.provenance(response.text) : null;
  const delivered = await deliver(response);
  if (!input.shadowMode) await check();
  if (!input.shadowMode && input.triggerMode !== "reaction" && mode !== "disabled") { try { await dependencies.state.commitSuccessfulExchange({
    guildId: input.guildId, channelId: input.channelId, userId: input.currentUser.id,
    userMessage: lease.current.content.slice(0, 1000), assistantMessage: delivered.slice(0, 2000),
    sourceMessageId: lease.current.messageId, sourceTimestampMs: lease.current.timestampMs, channelMemoryMode: mode,
    contextProvenance: allowsDurableWrites(mode) ? lease.provenance(delivered.slice(0, 2000)) : null,
    assistantMessageIds: (response.characterDeliveryProof ?? []).map((part) => part.messageId), actions: [], now: dependencies.now(),
  }); } catch (error) { throw new ChatStateCommitError(error); } }
  return response;
}
