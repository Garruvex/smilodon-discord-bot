import type { MessageOriginRecord, MessageOriginStore } from "./message-origin-store.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { parseScopedContextProvenance } from "./context-provenance.js";
import { immutableSnapshot } from "../context/immutable-snapshot.js";
import { chatMemoryLimits } from "./chat-memory-policy.js";

export const sessionOriginLimits = { entries: 2048, serializedChars: 8_000_000, ttlMs: chatMemoryLimits.sessionTtlMs } as const;
const wrappers = new WeakMap<object, SessionMessageOriginStore>();
type Entry = { record: MessageOriginRecord; expiresAt: number; chars: number };
const keyFor = (guildId: string, channelId: string, messageId: string): string => JSON.stringify([guildId, channelId, messageId]);

// Retains only origin/dependency metadata in memory. Session proofs never use
// the backend's record() method and are lost on process restart.
export class SessionMessageOriginStore implements MessageOriginStore {
  private readonly entries = new Map<string, Entry>();
  private chars = 0;
  private nextSweep = Infinity;
  public constructor(private readonly backend: MessageOriginStore, private readonly now: () => number = () => Date.now()) {}
  private remove(key: string): void { const entry = this.entries.get(key); if (entry) this.chars -= entry.chars; this.entries.delete(key); }
  private prune(): void {
    const now = this.now(); if (now < this.nextSweep) return; this.nextSweep = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key); else this.nextSweep = Math.min(this.nextSweep, entry.expiresAt);
    }
  }
  public record(input: MessageOriginRecord): Promise<void> {
    this.remove(keyFor(input.guildId, input.channelId, input.messageId)); return this.backend.record(input);
  }
  public recordSession(input: MessageOriginRecord): Promise<void> {
    this.prune(); const key = keyFor(input.guildId, input.channelId, input.messageId); this.remove(key);
    const proof = parseScopedContextProvenance(input.contextProvenance, input);
    const expiresAt = Math.min(this.now() + sessionOriginLimits.ttlMs, input.createdAt + sessionOriginLimits.ttlMs);
    if (input.origin !== "chat" || !input.sourceMessageId || !Number.isFinite(input.createdAt) || expiresAt <= this.now() ||
        !proof || proof.coverage !== "complete" || proof.purpose && proof.purpose !== "reply" ||
        !proof.dependencies.some((source) => source.guildId === input.guildId && source.channelId === input.channelId && source.messageId === input.sourceMessageId)) throw new SocialOutputSuppressed();
    const record = immutableSnapshot({ guildId: input.guildId, channelId: input.channelId, messageId: input.messageId, origin: "chat" as const,
      sourceMessageId: input.sourceMessageId, createdAt: input.createdAt, contextProvenance: proof });
    const chars = JSON.stringify(record).length;
    this.entries.set(key, { record, expiresAt, chars }); this.chars += chars; this.nextSweep = Math.min(this.nextSweep, expiresAt);
    while (this.entries.size > sessionOriginLimits.entries || this.chars > sessionOriginLimits.serializedChars) this.remove(this.entries.keys().next().value!);
    return Promise.resolve();
  }
  public async find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null> {
    this.prune(); const entry = this.entries.get(keyFor(guildId, channelId, messageId));
    return entry ? immutableSnapshot(entry.record) : this.backend.find(guildId, channelId, messageId);
  }
  public async invalidateContextSubject(guildId: string, userId: string): Promise<void> {
    for (const [key, { record }] of this.entries) {
      const proof = record.contextProvenance;
      if (record.guildId === guildId && (proof?.audience.userId === userId || proof?.dependencies.some((source) => source.authorId === userId) ||
          proof?.actors?.some((actor) => actor.userId === userId) || proof?.resources?.some((resource) => resource.id === userId))) this.remove(key);
    }
    await this.backend.invalidateContextSubject?.(guildId, userId);
  }
}
export function withSessionMessageOrigins(store: MessageOriginStore): SessionMessageOriginStore {
  if (store instanceof SessionMessageOriginStore) return store;
  const known = wrappers.get(store); if (known) return known;
  const wrapper = new SessionMessageOriginStore(store); wrappers.set(store, wrapper); return wrapper;
}
