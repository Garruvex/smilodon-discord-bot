import type { Logger } from "pino";
import type { GuardedChatConversationInput } from "./chat-conversation-service.js";
import type { ChatProvider, PersonalMemoryExtractionAction } from "./chat-provider.js";
import type { ChatSessionExchange } from "./chat-state-store.js";
import type { MemoryEngine, ProposedMemory } from "../memory/memory.js";
import { allowsDurableWrites } from "../memory/memory-channel-policy.js";
import { conversationConfiguration } from "../context/conversation-configuration.js";
import { ConversationModelGateway } from "../context/conversation-model-gateway.js";
import { GuardedConversationContext } from "./guarded-conversation-context.js";
import { guardedToolResourcePort } from "./guarded-tool-gateway.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import type { PersonaDriftStore } from "./persona-drift-store.js";
import { normalizeForGroundingCheck, importanceRatingToLevel, validateMemoryActions } from "./chat-memory-policy.js";
import { validateGuildKnowledgeCandidates } from "./guild-knowledge-policy.js";
import { safeFailure } from "../diagnostics/chat-diagnostics.js";
import { hashContent } from "../assets/content-hash.js";
import { isRecipientCorrection } from "./character-decision.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { approveMemoryIngest } from "../context/approved-memory-ingest.js";

export async function runGuardedPostTurn(input: GuardedChatConversationInput, dropped: readonly ChatSessionExchange[], dependencies: {
  provider: ChatProvider; utility: ChatProvider | null; memory: MemoryEngine; customization: UserCustomizationStore | null;
  tools: ChatToolRegistry | null; drift: PersonaDriftStore | null; logger: Logger | null; now: () => number;
  mutate: (operation: () => Promise<void>) => Promise<void>;
  extraction?: Promise<readonly PersonalMemoryExtractionAction[] | null>;
  characterConfiguration?: (id: string) => Promise<string | null>;
}): Promise<void> {
  const mode = input.resolveMemoryMode?.() ?? input.channelMemoryModes?.[input.channelId] ?? "shared";
  if (!allowsDurableWrites(mode) || input.shadowMode || input.interaction === "reaction") return;
  const gateway = new ConversationModelGateway(dependencies.utility ?? dependencies.provider, dependencies.provider);
  if (!dependencies.extraction && !gateway.canExtract && (!dropped.length || !gateway.canConsolidate && !(input.personaDriftEnabled && dependencies.drift && gateway.canEvolveDrift))) return;
  const configuration = await conversationConfiguration(input.guildId, input.currentUser.id, input.configurationContext, dependencies.customization);
  const port = guardedToolResourcePort(input.guardedContextPort, dependencies.tools, { currentUser: input.currentUser,
    channelMode: mode, channelIsNsfw: input.channelIsNsfw ?? false, isOwner: input.isOwner ?? false }, undefined, configuration, dependencies.drift, dependencies.characterConfiguration);
  if (port.guildId !== input.guildId || port.channelId !== input.channelId || port.sourceMessageId !== input.sourceMessageId || port.actorId !== input.currentUser.id) throw new SocialOutputSuppressed();
  const context = await GuardedConversationContext.open(port, { count: 0, budget: 0, burstIds: [] });
  if (!context.durableWritesAllowed) return;
  if (!await context.resource({ kind: "persona_configuration", id: "current" })) return;
  const ingest = async (proposals: readonly ProposedMemory[], source: "live" | "consolidation"): Promise<void> => {
    if (!proposals.length) return;
    await dependencies.mutate(async () => {
      const currentMode = input.resolveMemoryMode?.() ?? mode;
      if (!allowsDurableWrites(currentMode) || !await context.validate()) return;
      const result = await dependencies.memory.ingest(approveMemoryIngest({ guildId: input.guildId, channelId: input.channelId, channelMode: currentMode, context,
        assertedByUserId: context.current.authorId, sourceMessageId: context.current.messageId, sourceTimestampMs: context.current.timestampMs,
        source, proposals, now: dependencies.now() }));
      if (result.failed || result.rejected) dependencies.logger?.warn({ guildId: input.guildId, channelId: input.channelId,
        failed: result.failed, rejected: result.rejected }, "Guarded post-turn memory ingest issues");
    });
  };
  try {
    if (!isRecipientCorrection(context.current.content)) {
      // Combined character extraction is untrusted output, with exactly the
      // same fresh human quotation/subject checks as standalone extraction.
      const combined = await dependencies.extraction?.catch(() => null);
      const actions = combined ?? await gateway.extractCurrent(context); const normalized = normalizeForGroundingCheck(context.current.content);
      const validated = validateMemoryActions(actions.slice(0, 2).filter((action) => action.aboutSpeaker &&
        !!normalizeForGroundingCheck(action.sourceQuote) && normalized.includes(normalizeForGroundingCheck(action.sourceQuote))).map((action) => ({
        action: action.action, topic: action.topic, slot: action.slot, statement: action.statement, subjectUserId: context.current.authorId,
        sourceQuote: action.sourceQuote, importance: importanceRatingToLevel(action.importance),
      })), new Set([context.current.authorId]));
      await ingest(validated.map((action): ProposedMemory => action.action === "remove" ? {
        action: "remove", ownerUserId: context.current.authorId, subjectType: "member", subjectId: context.current.authorId, topic: action.topic, slot: action.slot,
      } : { action: "upsert", audience: "private", ownerUserId: context.current.authorId, subjectType: "member", subjectId: context.current.authorId,
        kind: action.topic === "preference" ? "preference" : "fact", topic: action.topic, slot: action.slot, statement: action.statement!, channelScoped: true,
        sourceQuote: action.sourceQuote, sourceMessageId: context.current.messageId, sourceTimestampMs: context.current.timestampMs }), "live");
    }
  } catch (error) { dependencies.logger?.warn({ failure: safeFailure(error) }, "Guarded dedicated extraction omitted"); }
  try {
    const { facts, sessions } = await gateway.consolidate(context, dropped);
    const proposals: ProposedMemory[] = [];
    for (const fact of facts.slice(0, 2)) {
      const quote = normalizeForGroundingCheck(fact.sourceQuote ?? "");
      const source = quote ? sessions.find((session) => normalizeForGroundingCheck(session.user.content).includes(quote)) : null;
      if (!source?.user.sourceMessageId) continue;
      const candidates = validateGuildKnowledgeCandidates([{ ...fact, subjectId: fact.subjectType === "member" ? context.current.authorId : input.guildId,
        topic: "scene_summary", channelScoped: true, sourceQuote: fact.sourceQuote ?? "" }],
      { guildId: input.guildId, currentChannelId: input.channelId, currentUserId: context.current.authorId, allowedMemberIds: new Set([context.current.authorId]) });
      for (const candidate of candidates) proposals.push({ action: "upsert", audience: context.sharedMemoryAllowed ? "guild" : "private", ownerUserId: context.sharedMemoryAllowed ? null : context.current.authorId, kind: "episode",
        subjectType: candidate.subjectType, subjectId: candidate.subjectId, topic: candidate.topic, slot: candidate.slot, statement: candidate.statement,
        channelScoped: true, sourceQuote: fact.sourceQuote ?? null, sourceMessageId: source.user.sourceMessageId, sourceTimestampMs: source.user.createdAt });
    }
    await ingest(proposals, "consolidation");
  } catch (error) { dependencies.logger?.warn({ failure: safeFailure(error) }, "Guarded session consolidation omitted"); }
  if (input.personaDriftEnabled && dependencies.drift && dropped.length) try {
    await dependencies.drift.evolveScoped(context, gateway, dropped,
      configuration.persona.material.personalitySourceHash ?? hashContent(configuration.persona.material.text), dependencies.now());
  } catch (error) { dependencies.logger?.warn({ failure: safeFailure(error) }, "Guarded scoped drift evolution omitted"); }
}
