import type { ChatProvider, DroppedExchangeFact, StructuredCallOptions, PersonalMemoryExtractionAction } from "../chat/chat-provider.js";
import type { ChatSessionExchange } from "../chat/chat-state-store.js";
import { isGuardedContext, type GuardedConversationContext } from "../chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { allowsDurableWrites } from "../memory/memory-channel-policy.js";
import { personaDriftPayload, type ScopedPersonaDrift } from "../chat/persona-drift-provenance.js";

// Owns the session-to-model projection. Stored transcripts are candidates,
// never caller authority: the lease verifies human sources and actual bot
// deliveries again before any text reaches a consolidation model.
export class ConversationModelGateway {
  public constructor(private readonly provider: ChatProvider, private readonly fallback: ChatProvider | null = null) {}
  private options(context: GuardedConversationContext): StructuredCallOptions {
    if (!isGuardedContext(context) || !context.durableWritesAllowed) throw new SocialOutputSuppressed();
    return { beforeAttempt: async (): Promise<void> => { if (!await context.validate()) throw new SocialOutputSuppressed(); },
      ...(context.cancellationSignal ? { signal: context.cancellationSignal } : {}) };
  }
  private async sessions(context: GuardedConversationContext, candidates: readonly ChatSessionExchange[]): Promise<ChatSessionExchange[]> {
    if (!isGuardedContext(context)) throw new SocialOutputSuppressed();
    const records = await context.sessions(candidates.filter((record) => record.user.channelMemoryMode && allowsDurableWrites(record.user.channelMemoryMode)));
    await this.options(context).beforeAttempt!(); return records;
  }
  public async consolidate(context: GuardedConversationContext, candidates: readonly ChatSessionExchange[]): Promise<{ facts: readonly DroppedExchangeFact[]; sessions: readonly ChatSessionExchange[] }> {
    const sessions = await this.sessions(context, candidates);
    const provider = this.provider.summarizeDroppedExchanges ? this.provider : this.fallback;
    if (!sessions.length || !provider?.summarizeDroppedExchanges) return { facts: [], sessions };
    const facts = await provider.summarizeDroppedExchanges(sessions.map((record) => ({ user: record.user.content, assistant: record.assistant.content })),
      { id: context.current.authorId, displayName: context.current.authorDisplayName }, this.options(context));
    await this.options(context).beforeAttempt!(); return { facts, sessions };
  }
  public async extractCurrent(context: GuardedConversationContext): Promise<readonly PersonalMemoryExtractionAction[]> {
    if (!isGuardedContext(context)) throw new SocialOutputSuppressed();
    const provider = this.provider.extractPersonalMemories ? this.provider : this.fallback;
    const human = await context.humanCurrent(); if (!human || !provider?.extractPersonalMemories || context.scope.actorId !== human.authorId) return [];
    await this.options(context).beforeAttempt!();
    const result = await provider.extractPersonalMemories(human.content, "", { id: human.authorId, displayName: human.authorDisplayName }, this.options(context));
    await this.options(context).beforeAttempt!(); return result;
  }
  public async drift(context: GuardedConversationContext, candidates: readonly ChatSessionExchange[], previous: ScopedPersonaDrift | null,
    personalitySourceHash: string, epoch: string, now: number): Promise<ScopedPersonaDrift | null> {
    if (!isGuardedContext(context) || !context.sharedMemoryAllowed) return null;
    const sessions = await this.sessions(context, candidates);
    const provider = this.provider.evolvePersonaDrift ? this.provider : this.fallback;
    if (!sessions.length || !provider?.evolvePersonaDrift) return null;
    if (await context.resource({ kind: "persona_drift", id: epoch }) !== epoch) throw new SocialOutputSuppressed();
    const currentText = previous && previous.guildId === context.scope.guildId && previous.channelId === context.scope.channelId &&
      previous.personalitySourceHash === personalitySourceHash && previous.epoch === epoch && await context.derived(previous.contextProvenance, personaDriftPayload(previous), "character_state") ? previous.text : "";
    const result = await provider.evolvePersonaDrift(currentText, sessions.map((record) => ({ user: record.user.content, assistant: record.assistant.content })), this.options(context));
    await this.options(context).beforeAttempt!();
    const state = { guildId: context.scope.guildId, channelId: context.scope.channelId, epoch, personalitySourceHash, text: result.trim().slice(0, 1000), updatedAt: now };
    const contextProvenance = context.provenance(personaDriftPayload(state), "character_state");
    return contextProvenance ? { ...state, contextProvenance } : null;
  }
}
