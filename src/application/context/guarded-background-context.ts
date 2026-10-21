import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import type { ChannelHistoryMessage, ChannelHistoryReader } from "./channel-history-reader.js";
import { backgroundSourceHash, parseContextProvenance, type ContextProvenance } from "../chat/context-provenance.js";
import { hashContent } from "../assets/content-hash.js";
import { memoryClaimProof } from "../memory/memory-claim-provenance.js";
import type { Memory } from "../memory/memory.js";

const registered = new WeakSet<object>();
export type BackgroundModelPurpose = "summary" | "memory_extraction";
export type BackgroundValidationStatus = "current" | "changed" | "deadline";

// A bounded source snapshot, not a caller-supplied `filtered: true` assertion.
// Transport authorization remains responsible for fresh source/member reads.
export class GuardedBackgroundContext {
  public readonly messages: readonly Readonly<ChannelHistoryMessage>[];
  private closed = false;
  private passes = 0;
  private publicWebUsed = false;
  private readonly publicCitations = new Set<string>();
  private readonly publicTools = new Map<string, { name: string; outputHash: string }>();
  private constructor(public readonly purpose: BackgroundModelPurpose, messages: readonly ChannelHistoryMessage[],
    private readonly reader: ChannelHistoryReader, private readonly policyCurrent: () => boolean | Promise<boolean>,
    private readonly report?: (status: BackgroundValidationStatus) => void) {
    this.messages = Object.freeze(messages.map((message) => Object.freeze({ ...message })));
    Object.defineProperty(this, "messages", { writable: false, configurable: false });
    Object.defineProperty(this, "purpose", { writable: false, configurable: false });
    registered.add(this);
  }

  public static async open(purpose: BackgroundModelPurpose, messages: readonly ChannelHistoryMessage[], reader: ChannelHistoryReader,
    policyCurrent: () => boolean | Promise<boolean>, report?: (status: BackgroundValidationStatus) => void): Promise<GuardedBackgroundContext> {
    const first = messages[0];
    if (!first || messages.length > 500 || messages.reduce((sum, message) => sum + message.content.length, 0) > 200_000 ||
        new Set(messages.map((message) => message.id)).size !== messages.length || messages.some((message) =>
          message.guildId !== first.guildId || message.channelId !== first.channelId || !message.content || !message.authorId || !message.id)) throw new SocialOutputSuppressed();
    const context = new GuardedBackgroundContext(purpose, messages, reader, policyCurrent, report);
    await context.check(); return context;
  }

  public async check(): Promise<void> {
    if (!registered.has(this) || this.closed || ++this.passes > 64) throw new SocialOutputSuppressed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(); let status: BackgroundValidationStatus = "changed";
    try {
      const valid = await Promise.race([
        (async (): Promise<boolean> => await this.policyCurrent() && !!this.reader.validateBatch && await this.reader.validateBatch(this.messages, controller.signal) && await this.policyCurrent())(),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => { status = "deadline"; controller.abort(); resolve(false); }, 8000); }),
      ]);
      if (!valid) throw new SocialOutputSuppressed();
      status = "current";
    } catch (error) { this.closed = true; throw error; }
    finally { if (timer) clearTimeout(timer); this.report?.(status); }
  }

  public provenance(output: string, purpose: "memory_claim" | "character_state" = "memory_claim", userId: string | null = null): ContextProvenance | null {
    if (this.closed) return null;
    const first = this.messages[0]!;
    return parseContextProvenance({ version: 1, purpose, coverage: "complete", outputHash: hashContent(output),
      audience: { guildId: first.guildId, channelId: first.channelId, userId }, unresolved: [],
      ...(this.publicWebUsed ? { publicWeb: { citationHashes: [...this.publicCitations].sort() } } : {}),
      ...(this.publicTools.size ? { publicTools: [...this.publicTools.values()] } : {}),
      dependencies: this.messages.map((source) => ({ guildId: source.guildId, channelId: source.channelId, messageId: source.id,
        authorId: source.authorId, timestampMs: source.createdAt, projection: { kind: "background_text", chars: source.content.length },
        representationHash: backgroundSourceHash({ authorId: source.authorId, authorDisplayName: source.authorDisplayName, content: source.content, timestampMs: source.createdAt }) })) });
  }

  public async classificationClaims(records: readonly Memory[], now: number): Promise<Memory[]> {
    await this.check();
    const sources = new Map(this.messages.map((message) => [message.id, message]));
    const authors = new Set(this.messages.map((message) => message.authorId));
    const first = this.messages[0]!;
    let chars = 0;
    const admitted = records.slice(0, 128).filter((record) => {
      if (record.statement.length > 1000 || chars + record.statement.length > 3000) return false;
      const proof = memoryClaimProof(record.contextProvenance, record);
      if (!proof || record.moduleId || !["active", "candidate"].includes(record.status) || record.expiresAt !== null && record.expiresAt <= now ||
          record.guildId !== first.guildId || record.channelId !== null && record.channelId !== first.channelId ||
          record.isolationChannelId !== null && record.isolationChannelId !== first.channelId ||
          record.subjectType === "member" && !authors.has(record.subjectId) ||
          record.audience === "private" && (this.purpose !== "memory_extraction" || !this.messages.every((message) => message.authorId === record.ownerUserId)) ||
          proof.audience.guildId !== first.guildId || proof.audience.channelId !== first.channelId ||
          proof.audience.userId !== null && !this.messages.every((message) => message.authorId === proof.audience.userId) ||
          proof.resources?.length || proof.actors?.length) return false;
      const valid = proof.dependencies.every((dependency) => {
        const source = sources.get(dependency.messageId);
        return !!source && !dependency.assetsHash && dependency.guildId === first.guildId && dependency.channelId === first.channelId &&
          dependency.authorId === source.authorId && dependency.timestampMs === source.createdAt && dependency.projection?.kind === "background_text" &&
          dependency.projection.chars <= source.content.length && dependency.representationHash === backgroundSourceHash({ authorId: source.authorId,
            authorDisplayName: source.authorDisplayName, content: source.content.slice(0, dependency.projection.chars), timestampMs: source.createdAt });
      });
      if (valid) chars += record.statement.length;
      return valid;
    }).slice(0, 20);
    for (const record of admitted) {
      const proof = memoryClaimProof(record.contextProvenance, record)!;
      if (proof.publicWeb) { this.publicWebUsed = true; for (const hash of proof.publicWeb.citationHashes) this.publicCitations.add(hash); }
      for (const entry of proof.publicTools ?? []) this.publicTools.set(`${entry.name}:${entry.outputHash}`, entry);
    }
    return admitted.map((record) => ({ ...record, structuredValue: null }));
  }
}

export function isBackgroundContext(value: unknown, purpose: BackgroundModelPurpose): value is GuardedBackgroundContext {
  return !!value && typeof value === "object" && registered.has(value) && (value as GuardedBackgroundContext).purpose === purpose;
}
