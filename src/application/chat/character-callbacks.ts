import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Memory, MemoryRepository } from "../memory/memory.js";
import { contextProvenanceSchema } from "./context-provenance.js";
import { memoryClaimPayload } from "../memory/memory-claim-provenance.js";
import { isGuardedContext, type GuardedConversationContext } from "./guarded-conversation-context.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";

const callbackSchema = z.object({
  dueAt: z.number(), expiresAt: z.number(), status: z.enum(["pending", "claimed", "sending", "delivered", "uncertain", "cancelled"]),
  revision: z.number(), attempts: z.number().int().nonnegative(), attemptId: z.string().nullable(), leaseUntil: z.number().nullable(),
  messageId: z.string().nullable(), nextAttemptAt: z.number(), deliveryChannelId: z.string(),
  quotaDayStart: z.number().optional(),
  sourceIds: z.array(z.string()).default([]),
  eventMessageId: z.string().nullable().default(null),
  contextProvenance: contextProvenanceSchema.optional(),
});
export type CharacterCallbackState = z.infer<typeof callbackSchema>;
export function callbackProofPayload(memory: Memory, state: CharacterCallbackState): string {
  return JSON.stringify({ claim: memoryClaimPayload(memory), memoryId: memory.id, revision: state.revision, dueAt: state.dueAt,
    expiresAt: state.expiresAt, channelId: state.deliveryChannelId, eventMessageId: state.eventMessageId, sourceIds: [...state.sourceIds].sort() });
}
export function callbackDateUnresolved(memory: Memory): boolean {
  const metadata = memory.structuredValue;
  return !!metadata && typeof metadata === "object" && "callbackDateUnresolved" in metadata && metadata.callbackDateUnresolved === memory.updatedAt;
}
export function callbackDateDeferred(memory: Memory, now: number): boolean {
  const metadata = memory.structuredValue;
  const state = metadata && typeof metadata === "object" && "callbackDatePlanning" in metadata ? metadata.callbackDatePlanning : null;
  const parsed = z.object({ revision: z.number(), retryAt: z.number() }).safeParse(state);
  return parsed.success && parsed.data.revision === memory.updatedAt && parsed.data.retryAt > now;
}
export function callbackState(memory: Memory): CharacterCallbackState | null {
  const metadata = memory.structuredValue;
  const parsed = callbackSchema.safeParse(metadata && typeof metadata === "object" && "callback" in metadata ? metadata.callback : null);
  return parsed.success ? parsed.data : null;
}
export class CharacterCallbacks {
  public constructor(private readonly repository: MemoryRepository) {}
  public async beginDatePlanning(memory: Memory, now: number): Promise<Memory | null> {
    if (callbackDateUnresolved(memory) || callbackDateDeferred(memory, now)) return null;
    const metadata = memory.structuredValue && typeof memory.structuredValue === "object" ? memory.structuredValue : {};
    const value = { ...metadata, callbackDatePlanning: { revision: memory.updatedAt, retryAt: now + 30 * 60_000 } };
    const changed = await this.repository.compareAndSetStructuredValue?.({ guildId: memory.guildId, memoryId: memory.id, updatedAt: memory.updatedAt,
      expected: memory.structuredValue, value });
    return changed ? { ...memory, structuredValue: value } : null;
  }
  public async markDateUnresolved(memory: Memory): Promise<void> {
    const metadata = memory.structuredValue && typeof memory.structuredValue === "object" ? memory.structuredValue : {};
    await this.repository.compareAndSetStructuredValue?.({ guildId: memory.guildId, memoryId: memory.id, updatedAt: memory.updatedAt,
      expected: memory.structuredValue, value: { ...metadata, callbackDateUnresolved: memory.updatedAt } });
  }
  private async update(memory: Memory, callback: CharacterCallbackState): Promise<Memory | null> {
    const metadata = memory.structuredValue && typeof memory.structuredValue === "object" ? memory.structuredValue : {};
    const value = { ...metadata, callback };
    const changed = await this.repository.compareAndSetStructuredValue?.({ guildId: memory.guildId, memoryId: memory.id,
      updatedAt: memory.updatedAt, expected: memory.structuredValue, value });
    return changed ? { ...memory, structuredValue: value } : null;
  }
  public async plan(memory: Memory, dueAt: number, channelId: string, context?: GuardedConversationContext): Promise<Memory | null> {
    if (callbackState(memory) || memory.moduleId || memory.subjectType !== "member" || !Number.isFinite(dueAt)) return null;
    if (context && (!isGuardedContext(context) || !(await context.memories([memory], true)).length || !await context.validate())) throw new SocialOutputSuppressed();
    const storedSources = await this.repository.findSources(memory.id);
    const sources = context ? await context.humanQuotes(storedSources.filter((source) => source.assertedByUserId === memory.subjectId)) : storedSources;
    if (context && !sources.length) return null;
    const sourceIds = sources.map((source) => source.id);
    const eventMessageId = sources.filter((source) => source.sourceChannelId === channelId && source.assertedByUserId === memory.subjectId && source.sourceQuote).at(-1)?.sourceMessageId ?? null;
    const state: CharacterCallbackState = { dueAt, expiresAt: dueAt + 3 * 86_400_000, status: "pending", revision: memory.updatedAt,
      attempts: 0, attemptId: null, leaseUntil: null, messageId: null, nextAttemptAt: dueAt, deliveryChannelId: channelId, sourceIds, eventMessageId };
    if (context) {
      if (!await context.validate()) throw new SocialOutputSuppressed();
      const proof = context.provenance(callbackProofPayload(memory, state), "character_state");
      if (!proof) throw new SocialOutputSuppressed(); state.contextProvenance = proof;
    }
    return this.update(memory, state);
  }
  public async claim(memory: Memory, now: number, maxPerDay = 1, dayStart = Math.floor(now / 86_400_000) * 86_400_000): Promise<Memory | null> {
    const callback = callbackState(memory);
    if (!callback || callback.revision !== memory.updatedAt || callback.dueAt > now || callback.nextAttemptAt > now || callback.expiresAt <= now || callback.attempts >= 3) return null;
    if (callback.status === "sending" && (callback.leaseUntil ?? 0) <= now) {
      await this.update(memory, { ...callback, status: "uncertain", leaseUntil: null }); return null;
    }
    if (callback.status !== "pending" && !(callback.status === "claimed" && (callback.leaseUntil ?? Infinity) <= now)) return null;
    const metadata = memory.structuredValue && typeof memory.structuredValue === "object" ? memory.structuredValue : {};
    const value = { ...metadata, callback: { ...callback, status: "claimed", attemptId: randomUUID(), attempts: callback.attempts + 1, leaseUntil: now + 60_000, quotaDayStart: dayStart } };
    if (!this.repository.claimCallbackMemory || maxPerDay <= 0) return null;
    const changed = await this.repository.claimCallbackMemory({ guildId: memory.guildId, memoryId: memory.id, updatedAt: memory.updatedAt,
      expected: memory.structuredValue, value, maxPerDay, dayStart, now });
    return changed ? { ...memory, structuredValue: value } : null;
  }
  public async send(claim: Memory, now: number, eligible: (memory: Memory) => Promise<boolean>, deliver: (memory: Memory) => Promise<string>): Promise<boolean> {
    const expected = callbackState(claim);
    const fresh = await this.repository.findById(claim.guildId, claim.id);
    const state = fresh && callbackState(fresh);
    if (!fresh || !state || !expected || state.attemptId !== expected.attemptId || state.status !== "claimed" || fresh.updatedAt !== state.revision || (state.leaseUntil ?? 0) <= now) return false;
    if (!await eligible(fresh)) { await this.update(fresh, { ...state, status: "cancelled", leaseUntil: null }); return false; }
    const sending = await this.update(fresh, { ...state, status: "sending" });
    if (!sending) return false;
    try {
      // A final eligibility check follows the CAS, immediately before the
      // actual side effect; uncertain sends are never retried blindly.
      if (!await eligible(sending)) { await this.update(sending, { ...state, status: "cancelled", leaseUntil: null }); return false; }
      const messageId = await deliver(sending);
      await this.update(sending, { ...state, status: "delivered", messageId, leaseUntil: null });
      return true;
    } catch (error) {
      const knownFailure = error instanceof CallbackKnownFailure;
      await this.update(sending, { ...state, status: knownFailure ? "pending" : "uncertain", leaseUntil: null,
        nextAttemptAt: now + Math.min(3_600_000, 60_000 * 2 ** state.attempts) });
      return false;
    }
  }
  public async failBeforeSend(claim: Memory, now: number): Promise<void> {
    const state = callbackState(claim); if (!state || state.status !== "claimed") return;
    await this.update(claim, { ...state, status: "pending", leaseUntil: null,
      nextAttemptAt: now + Math.min(3_600_000, 60_000 * 2 ** state.attempts) });
  }
}
export class CallbackKnownFailure extends Error {}
