import { hashContent } from "../assets/content-hash.js";
import type { ChannelHistoryMessage, ChatImage, ChatRequest, ChatSource, ChatUser, ConversationEvent } from "./chat-provider.js";
import { publicWebSources } from "./public-web-sources.js";
import { memoryClaimProof } from "../memory/memory-claim-provenance.js";
import { canRecall, canRecallOrdinaryMemory, type Memory, type MemorySource } from "../memory/memory.js";
import type { ChatSessionExchange } from "./chat-state-store.js";
import { budgetEligibleHistory } from "./eligible-channel-history.js";
import { contextProvenanceLimits, dependencyMatchesSource, parseContextProvenance, parseScopedContextProvenance, type ContextProvenance } from "./context-provenance.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";

export const guardedContextLimits = { pageSize: 100, pages: 3, targetedPages: 5, replyDepth: 20, messageChars: 4000, replyChars: 6000, burstMessages: 16, burstChars: 6000, targetedMessages: 8,
  dependencies: 128, sourceReads: 4096, workMs: 20_000, phaseMs: 8_000, maxValidationPasses: 64 } as const;
export interface GuardedContextSource {
  assets?: readonly GuardedAssetDescriptor[];
  event: ChannelHistoryMessage;
  origin: "human" | "chat" | "other";
  provenance: ContextProvenance | null;
}
export interface GuardedAssetDescriptor { id: string; contentType: string; size: number }
export const guardedAssetsHash = (assets: readonly GuardedAssetDescriptor[]): string => hashContent(JSON.stringify(
  [...assets].map(({ id, contentType, size }) => ({ id, contentType, size })).sort((a, b) => a.id.localeCompare(b.id))));
export interface GuardedContextPort {
  turnSignal?: AbortSignal;
  resource?: (key: GuardedResourceKey, signal: AbortSignal) => Promise<string | null>;
  work?: (phase: "assembly" | "sessions" | "memory" | "assets" | "validation", status: "completed" | "deadline" | "failed", durationMs: number) => void;
  loadAsset?: (messageId: string, assetId: string, signal: AbortSignal) => Promise<string | null>;
  persist?: boolean;
  audienceUserId?: string | null;
  coverage?: (report: GuardedContextReport) => void;
  validation?: (status: "current" | "changed" | "deadline" | "bounded", reads: number) => void;
  guildId: string; channelId: string; sourceMessageId: string; actorId: string | null;
  read: (messageId: string, signal: AbortSignal) => Promise<GuardedContextSource | null>;
  page: (before: string | null, signal: AbortSignal) => Promise<readonly string[]>;
  actor: (userId: string, signal: AbortSignal) => Promise<ChatUser | null>;
  // Fresh transport data for this validation phase only. Every subsequent read
  // still performs author, scope, forget and provenance checks.
  prepareValidation?: (messageIds: readonly string[], signal: AbortSignal) => Promise<void>;
  policyCurrent(): boolean;
}
export type GuardedResourceKey = Pick<NonNullable<ContextProvenance["resources"]>[number], "kind" | "id">;
export interface GuardedContextReport {
  replyChain: number; replyBounded: boolean; burst: number; eligibleReactors: number; omittedReactors: number;
  requested: number; fetched: number; examined: number; duplicates: number; unverifiedBot: number; invalidatedDerived: number;
  selectedIds: string[]; oldestTimestampMs: number | null; newestTimestampMs: number | null;
  eligible: number; selected: number; pages: number; targetedPages: number;
  omitted: number; truncated: number; sourceReads: number;
  status: "filled" | "end" | "scan_cap" | "deadline" | "fetch_failed" | "source_ineligible" | "ineligible_reaction" | "no_progress";
}
const registered = new WeakSet<object>();
export function isGuardedContext(value: unknown): value is GuardedConversationContext {
  return typeof value === "object" && value !== null && registered.has(value);
}
const same = (a: ChannelHistoryMessage, b: ChannelHistoryMessage): boolean =>
  a.messageId === b.messageId && a.authorId === b.authorId && a.channelId === b.channelId && a.timestampMs === b.timestampMs &&
  a.content === b.content && a.replyToMessageId === b.replyToMessageId && JSON.stringify(a.author) === JSON.stringify(b.author);
export const contextSourceHash = (event: ChannelHistoryMessage): string => hashContent(JSON.stringify({
  content: event.content, author: event.author, authorId: event.authorId, timestampMs: event.timestampMs, replyToMessageId: event.replyToMessageId,
}));
const compact = (event: ChannelHistoryMessage): ChannelHistoryMessage => ({ ...event, imageCount: 0,
  content: event.content.slice(0, guardedContextLimits.messageChars), ...(event.content.length > guardedContextLimits.messageChars ? { contentTruncated: true } : {}) });

// This lease is registered at runtime, owns source resolution, and issues
// complete text provenance only for the closed, whitelisted assembly below.
// It is deliberately narrower than the separately planned universal gateway.
export class GuardedConversationContext {
  public get cancellationSignal(): AbortSignal | undefined { return this.port.turnSignal; }
  private remainingMs: number = guardedContextLimits.workMs;
  private reads = 0;
  private passes = 0;
  private closed = false;
  private cache = new Map<string, Promise<GuardedContextSource | null>>();
  private signal = new AbortController().signal;
  private readonly evidence = new Map<string, ChannelHistoryMessage>();
  private publicWebUsed = false;
  private readonly publicWebCitations = new Set<string>();
  private readonly publicTools = new Map<string, { name: string; outputHash: string }>();
  private readonly resources = new Map<string, NonNullable<ContextProvenance["resources"]>[number]>();
  private readonly assetDependencies = new Map<string, string>();
  private phaseQueue: Promise<void> = Promise.resolve();
  public readonly report: GuardedContextReport = { replyChain: 0, replyBounded: false, burst: 0, eligibleReactors: 0, omittedReactors: 0, requested: 40, fetched: 0, examined: 0, duplicates: 0, unverifiedBot: 0, invalidatedDerived: 0, selectedIds: [], oldestTimestampMs: null, newestTimestampMs: null, eligible: 0, selected: 0, pages: 0, targetedPages: 0,
    omitted: 0, truncated: 0, sourceReads: 0, status: "end" };
  public current!: ChannelHistoryMessage;
  public history: ChannelHistoryMessage[] = [];
  public replyChain: ChannelHistoryMessage[] = [];
  public burst: ChannelHistoryMessage[] = [];
  public currentEvent: ConversationEvent | undefined;
  private reactionActors = new Map<string, ChatUser>();
  private constructor(private readonly port: GuardedContextPort) { registered.add(this); }

  private phase<T>(operation: () => Promise<T>, phase: "assembly" | "sessions" | "memory" | "assets" | "validation" = "assembly"): Promise<T> {
    const work = this.phaseQueue.then(() => this.runPhase(operation, phase));
    this.phaseQueue = work.then(() => undefined, () => undefined); return work;
  }
  private async runPhase<T>(operation: () => Promise<T>, phase: "assembly" | "sessions" | "memory" | "assets" | "validation"): Promise<T> {
    if (this.closed || !this.port.policyCurrent() || this.remainingMs <= 0) throw new SocialOutputSuppressed();
    const controller = new AbortController(); this.signal = controller.signal; this.cache = new Map();
    const started = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    let status: "completed" | "deadline" | "failed" = "failed";
    try {
      const result = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { status = "deadline"; this.closed = true; controller.abort(); this.report.status = "deadline"; reject(new SocialOutputSuppressed()); },
          Math.min(this.remainingMs, guardedContextLimits.phaseMs));
      })]);
      status = "completed"; return result;
    } finally {
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - started; this.remainingMs -= durationMs;
      this.port.work?.(phase, status, durationMs);
    }
  }

  private async read(id: string, path = new Set<string>()): Promise<GuardedContextSource | null> {
    if (this.closed || this.signal.aborted || path.has(id) || path.size >= guardedContextLimits.replyDepth) return null;
    const cached = this.cache.get(id); if (cached) return cached;
    if (++this.reads > guardedContextLimits.sourceReads) return null;
    this.report.sourceReads = this.reads;
    const next = new Set(path).add(id);
    const pending = (async (): Promise<GuardedContextSource | null> => {
      const source = await this.port.read(id, this.signal).catch(() => null);
      if (!source || source.event.channelId !== this.port.channelId || source.event.messageId !== id || source.origin === "other") return null;
      if (this.assetDependencies.has(id) && guardedAssetsHash(source.assets ?? []) !== this.assetDependencies.get(id)) return null;
      if (source.origin === "chat") {
        const proof = parseScopedContextProvenance(source.provenance, { guildId: this.port.guildId, channelId: this.port.channelId,
          ...(this.port.actorId ? { userId: this.port.actorId } : {}) });
        if (!proof || proof.purpose && proof.purpose !== "reply" || proof.coverage !== "complete") { this.report.unverifiedBot++; return null; }
        if (proof.outputHash !== hashContent(source.event.content)) { this.report.invalidatedDerived++; return null; }
        if (proof.outputAssetsHash && proof.outputAssetsHash !== guardedAssetsHash(source.assets ?? [])) return null;
        if (!await this.proofSourcesCurrent(proof, next)) { this.report.invalidatedDerived++; return null; }
      }
      return source;
    })();
    this.cache.set(id, pending); return pending;
  }

  private async retain(id: string): Promise<ChannelHistoryMessage | null> {
    const source = await this.read(id); if (!source) { this.report.omitted++; return null; }
    const add = async (item: GuardedContextSource): Promise<boolean> => {
      if (this.evidence.has(item.event.messageId)) return true;
      if (!this.evidence.has(item.event.messageId) && this.evidence.size >= guardedContextLimits.dependencies) return false;
      this.evidence.set(item.event.messageId, item.event);
      if (item.origin === "chat") for (const dependency of item.provenance!.dependencies) {
        const original = await this.read(dependency.messageId); if (!original || !await add(original)) return false;
        if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
      }
      if (item.provenance && !await this.retainActors(item.provenance)) return false;
      for (const entry of item.provenance?.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
      return true;
    };
    const before = new Set(this.evidence.keys());
    if (!await add(source)) {
      for (const key of this.evidence.keys()) if (!before.has(key)) this.evidence.delete(key);
      this.report.omitted++; return null;
    }
    // Keep external-source lineage when reusing a previously guarded answer.
    // Its protected Discord dependencies are still revalidated independently.
    for (const id of this.evidence.keys()) {
      if (before.has(id)) continue;
      const proof = (await this.read(id))?.provenance;
      this.inheritPublicTools(proof);
      if (proof?.publicWeb) {
        this.publicWebUsed = true;
        for (const digest of proof.publicWeb.citationHashes) this.publicWebCitations.add(digest);
      }
    }
    return compact(source.event);
  }

  public static async open(port: GuardedContextPort, input: { count: number; budget: number; minReactors?: number; burstIds: readonly string[]; event?: ConversationEvent }): Promise<GuardedConversationContext> {
    const lease = new GuardedConversationContext(port); lease.report.requested = input.count;
    try { await lease.phase(async () => {
      const current = await lease.retain(port.sourceMessageId); if (!current) { lease.report.status = "source_ineligible"; throw new SocialOutputSuppressed(); }
      if (port.actorId !== null && port.actorId !== current.authorId) throw new SocialOutputSuppressed();
      if (input.event?.type === "reaction_snapshot" && (input.event.targetMessageId !== current.messageId || input.event.channelId !== port.channelId ||
        input.event.targetAuthorId !== current.authorId || (await lease.read(current.messageId))?.origin !== "chat")) throw new SocialOutputSuppressed();
      lease.current = current;
      lease.currentEvent = input.event?.type === "reaction_snapshot" ? input.event : { type: "message", messageId: current.messageId,
        channelId: port.channelId, authorId: current.authorId, timestampMs: current.timestampMs,
        replyToMessageId: current.replyToMessageId ?? null, mentionedUserIds: [...current.content.matchAll(/<@!?(\d+)>/gu)].map((match) => match[1]!) };
      const ancestors: ChannelHistoryMessage[] = []; let reference = current.replyToMessageId;
      const visited = new Set([current.messageId]);
      for (let depth = 0; reference && depth < guardedContextLimits.replyDepth && !visited.has(reference); depth++) {
        visited.add(reference); const source = await lease.read(reference); if (!source) { lease.report.omitted++; break; }
        const parent = compact(source.event); ancestors.push(parent); reference = parent.replyToMessageId;
      }
      lease.replyChain = [];
      const boundedReply = budgetEligibleHistory(ancestors.reverse(), guardedContextLimits.replyDepth, guardedContextLimits.replyChars);
      lease.report.truncated += boundedReply.truncated; lease.report.omitted += boundedReply.budgetOmitted;
      for (const event of boundedReply.messages) if (await lease.retain(event.messageId)) lease.replyChain.push(event);
      lease.report.replyChain = lease.replyChain.length; lease.report.replyBounded = !!reference;
      for (const id of [...new Set(input.burstIds)].slice(-guardedContextLimits.burstMessages)) {
        const source = await lease.read(id); const event = source ? compact(source.event) : null; if (event && event.authorId === current.authorId && id !== current.messageId) lease.burst.push(event);
      }
      if (lease.currentEvent.type === "message") lease.burst.push(current);
      const boundedBurst = budgetEligibleHistory(lease.burst, guardedContextLimits.burstMessages, guardedContextLimits.burstChars);
      lease.burst = [];
      for (const event of boundedBurst.messages) if (await lease.retain(event.messageId)) lease.burst.push(event);
      lease.report.truncated += boundedBurst.truncated; lease.report.omitted += boundedBurst.budgetOmitted;
      lease.report.burst = lease.burst.length;
      const exclude = new Set([current.messageId, ...lease.replyChain.map((event) => event.messageId), ...lease.burst.map((event) => event.messageId)]);
      const candidates: ChannelHistoryMessage[] = []; let cursor: string | null = lease.currentEvent.type === "reaction_snapshot" ? null : current.messageId;
      const backward = /\b(?:earlier|previous|above|before)\b|之前|前面|上面|剛剛|さっき|前の/iu.test(current.content);
      const maxPages = guardedContextLimits.pages + (backward ? guardedContextLimits.targetedPages : 0);
      for (let page = 0; page < maxPages; page++) {
        let ids: readonly string[];
        try { ids = (await port.page(cursor, lease.signal)).slice(0, guardedContextLimits.pageSize); }
        catch { lease.report.status = "fetch_failed"; break; }
        if (page < guardedContextLimits.pages) lease.report.pages++; else lease.report.targetedPages++;
        lease.report.fetched += ids.length;
        for (const id of ids) {
          lease.report.examined++;
          if (exclude.has(id) || candidates.some((event) => event.messageId === id)) { lease.report.duplicates++; continue; }
          const source = await lease.read(id); if (!source) { lease.report.omitted++; continue; }
          lease.report.eligible++; candidates.push(compact(source.event));
          if (candidates.length >= input.count && !backward) break;
        }
        const next = ids.at(-1);
        if (candidates.length >= input.count && !backward) { lease.report.status = "filled"; break; }
        if (ids.length < guardedContextLimits.pageSize || !next) { lease.report.status = "end"; break; }
        if (next === cursor) { lease.report.status = "no_progress"; break; }
        cursor = next; lease.report.status = "scan_cap";
      }
      // A backward reference adds a bounded relevance search; it does not
      // turn every mention into a scan of the channel's entire history.
      const baseline = candidates.slice(0, input.count);
      const terms = current.content.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
      const targeted = backward ? candidates.slice(input.count).map((event) => ({ event, score:
        terms.reduce((total, term) => total + Number(event.content.toLowerCase().includes(term)), 0) * 2 + Number(event.authorId === current.authorId) }))
        .filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, guardedContextLimits.targetedMessages).map((item) => item.event) : [];
      const bounded = budgetEligibleHistory([...baseline, ...targeted], input.count + targeted.length, input.budget);
      lease.report.truncated += bounded.truncated; lease.history = [];
      for (const event of bounded.messages) if (await lease.retain(event.messageId)) lease.history.push(event);
      lease.report.selected = lease.history.length;
      lease.report.omitted += Math.max(0, candidates.length - lease.history.length);
      lease.report.selectedIds = lease.history.map((event) => event.messageId);
      lease.report.oldestTimestampMs = lease.history[0]?.timestampMs ?? null;
      lease.report.newestTimestampMs = lease.history.at(-1)?.timestampMs ?? null;
      if (lease.currentEvent.type === "reaction_snapshot") {
        const reactions = [];
        for (const reaction of lease.currentEvent.reactions.slice(0, 20)) {
          const actorIds = [];
          for (const id of reaction.actorIds.slice(0, 100)) {
            const actor = await port.actor(id, lease.signal); if (!actor) { lease.report.omittedReactors++; continue; }
            lease.reactionActors.set(id, actor); actorIds.push(id);
          }
          if (actorIds.length) reactions.push({ ...reaction, actorIds });
        }
        lease.report.eligibleReactors = lease.reactionActors.size;
        if (lease.reactionActors.size < (input.minReactors ?? 1)) { lease.report.status = "ineligible_reaction"; throw new SocialOutputSuppressed(); }
        lease.currentEvent = { ...lease.currentEvent, reactions };
      }
      const selected = new Map([current, ...lease.replyChain, ...lease.history, ...lease.burst].map((event) => [event.messageId, event]));
      for (const event of selected.values()) {
        const target = event.replyToMessageId ? selected.get(event.replyToMessageId) : null;
        event.replyToAuthorId = target?.authorId ?? null;
        event.replyToAuthorDisplayName = target?.authorDisplayName ?? null;
      }
    }); } finally { port.coverage?.({ ...lease.report }); }
    return lease;
  }

  public async sessions(exchanges: readonly ChatSessionExchange[]): Promise<ChatSessionExchange[]> {
    return this.phase(async () => {
      const selected: ChatSessionExchange[] = [];
      if (!this.port.actorId || this.currentEvent?.type === "reaction_snapshot") return selected;
      const actorId = this.port.actorId;
      const candidates = exchanges.slice(-4).flatMap((exchange) => {
        const proof = parseScopedContextProvenance(exchange.contextProvenance, { guildId: this.port.guildId, channelId: this.port.channelId, userId: actorId });
        const sourceId = exchange.user.sourceMessageId; const deliveryIds = exchange.assistant.messageIds;
        if (!proof || proof.purpose && proof.purpose !== "reply" || proof.coverage !== "complete" || proof.outputHash !== hashContent(exchange.assistant.content) ||
          !sourceId || !deliveryIds?.length) return [];
        return [{ exchange, proof, sourceId, deliveryIds }];
      });
      if (!candidates.length) return selected;
      await this.port.prepareValidation?.([...new Set([this.current.messageId, ...candidates.flatMap(({ proof, sourceId, deliveryIds }) =>
        [sourceId, ...deliveryIds, ...proof.dependencies.map((dependency) => dependency.messageId)])])], this.signal);
      for (const { exchange, proof, sourceId, deliveryIds } of candidates) {
        const human = await this.read(sourceId);
        if (!human || human.event.authorId !== this.port.actorId || !human.event.content.startsWith(exchange.user.content)) continue;
        let valid = await this.proofSourcesCurrent(proof);
        let delivered = "";
        for (const id of deliveryIds) { const source = await this.read(id); if (!source || source.origin !== "chat") { valid = false; break; } delivered += source.event.content; }
        const normalized = (value: string): string => value.replace(/\s+/gu, "");
        if (!valid || !normalized(delivered).includes(normalized(exchange.assistant.content))) continue;
        for (const id of [...proof.dependencies.map((source) => source.messageId), ...deliveryIds, sourceId]) if (!await this.retain(id)) valid = false;
        if (valid) {
          if (!await this.retainActors(proof)) continue;
          for (const entry of proof.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
          for (const dependency of proof.dependencies) if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
          selected.push(exchange);
        }
      }
      return selected;
    }, "sessions");
  }

  public async memories(records: readonly Memory[], retain = false, now = Date.now()): Promise<Memory[]> {
    return this.claims(records, retain, now, false);
  }

  public async characterMemories(records: readonly Memory[], retain = false, now = Date.now()): Promise<Memory[]> {
    return this.claims(records, retain, now, true);
  }

  public async classificationClaims(records: readonly Memory[], now = Date.now()): Promise<Memory[]> {
    return this.claims(records, true, now, false, true);
  }

  private async claims(records: readonly Memory[], retain: boolean, now: number, character: boolean, classification = false): Promise<Memory[]> {
    return this.phase(async () => {
      const allowed: Memory[] = []; let chars = 0;
      for (const record of records.slice(0, 128)) {
        if (allowed.length === 20) break;
        if (record.statement.length > 1000 || chars + record.statement.length > 3000) continue;
        const proof = memoryClaimProof(record.contextProvenance, record);
        if (!proof || proof.audience.guildId !== this.port.guildId || proof.audience.channelId !== this.port.channelId ||
            proof.audience.userId !== null && proof.audience.userId !== this.port.actorId ||
            record.audience === "private" && (this.port.audienceUserId !== record.ownerUserId || this.port.actorId !== record.ownerUserId) ||
            (character ? !record.moduleId || !canRecall(record, { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.actorId ?? "" }, now)
              : !canRecallOrdinaryMemory(classification && record.status === "candidate" ? { ...record, status: "active" } : record,
                { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.actorId ?? "" }, now))) continue;
        const subject = record.subjectType === "member" ? await this.port.actor(record.subjectId, this.signal) : null;
        if (record.subjectType === "member" && !subject) continue;
        let valid = await this.proofSourcesCurrent(proof);
        if (!valid) continue;
        if (retain) {
          if (!await this.retainActors(proof)) continue;
          for (const entry of proof.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
          const before = new Set(this.evidence.keys());
          for (const dependency of proof.dependencies) if (!await this.retain(dependency.messageId)) valid = false;
          if (!valid) { for (const id of this.evidence.keys()) if (!before.has(id)) this.evidence.delete(id); continue; }
          for (const dependency of proof.dependencies) if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
          if (subject) this.reactionActors.set(subject.id, subject);
          this.inheritPublicTools(proof);
          if (proof.publicWeb) { this.publicWebUsed = true; for (const digest of proof.publicWeb.citationHashes) this.publicWebCitations.add(digest); }
        }
        // Unproven alias/callback metadata never rides along with an otherwise
        // valid statement. Its own source migration is independent.
        allowed.push({ ...record, structuredValue: character ? record.structuredValue : null });
        chars += record.statement.length;
      }
      return allowed;
    }, "memory");
  }

  private async retainActors(proof: ContextProvenance): Promise<boolean> {
    for (const entry of proof.actors ?? []) {
      const actor = await this.port.actor(entry.userId, this.signal);
      if (!actor || hashContent(JSON.stringify(actor)) !== entry.representationHash) return false;
      const prior = this.reactionActors.get(actor.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(actor)) return false;
      this.reactionActors.set(actor.id, actor);
    }
    return true;
  }

  private async proofSourcesCurrent(proof: ContextProvenance, path = new Set<string>()): Promise<boolean> {
    if (proof.coverage !== "complete" || proof.audience.guildId !== this.port.guildId || proof.audience.channelId !== this.port.channelId ||
        proof.audience.userId !== null && proof.audience.userId !== this.port.audienceUserId || !await this.validateResources(proof)) return false;
    for (const dependency of proof.actors ?? []) {
      const actor = await this.port.actor(dependency.userId, this.signal);
      if (!actor || hashContent(JSON.stringify(actor)) !== dependency.representationHash) return false;
    }
    for (const dependency of proof.dependencies) {
      if (dependency.guildId !== this.port.guildId || dependency.channelId !== this.port.channelId) return false;
      const source = await this.read(dependency.messageId, path);
      if (!source || !dependencyMatchesSource(dependency, source.event, contextSourceHash(source.event)) ||
          dependency.assetsHash && dependency.assetsHash !== guardedAssetsHash(source.assets ?? [])) return false;
    }
    return true;
  }

  public async derived(value: unknown, output: string, purpose: "character_state"): Promise<boolean> {
    return this.phase(async () => {
      const proof = parseContextProvenance(value);
      if (!proof || proof.purpose !== purpose || proof.outputHash !== hashContent(output) || !await this.proofSourcesCurrent(proof)) return false;
      for (const entry of proof.dependencies) {
        if (!await this.retain(entry.messageId)) return false;
        if (entry.assetsHash) this.assetDependencies.set(entry.messageId, entry.assetsHash);
      }
      if (!await this.retainActors(proof)) return false;
      for (const entry of proof.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
      this.inheritPublicTools(proof);
      if (proof.publicWeb) { this.publicWebUsed = true; for (const digest of proof.publicWeb.citationHashes) this.publicWebCitations.add(digest); }
      return true;
    }, "memory");
  }

  private async validateResources(proof: Pick<ContextProvenance, "resources">): Promise<boolean> {
    for (const entry of proof.resources ?? []) {
      const prior = this.resources.get(`${entry.kind}:${entry.id}`);
      if (prior && prior.representationHash !== entry.representationHash) return false;
      if (!this.port.resource || entry.kind === "birthday" && !await this.port.actor(entry.id, this.signal)) return false;
      const value = await this.port.resource(entry, this.signal).catch(() => null);
      if (value === null || hashContent(value) !== entry.representationHash) return false;
    }
    return true;
  }

  public async humanQuotes(records: readonly MemorySource[]): Promise<MemorySource[]> {
    return this.phase(async () => {
      const admitted: MemorySource[] = [];
      let chars = 0;
      for (const record of records.slice(0, 32)) {
        if (!record.sourceMessageId || !record.sourceQuote || record.sourceChannelId !== this.port.channelId) continue;
        if (record.sourceQuote.length > 2000 || chars + record.sourceQuote.length > 8000) continue;
        const source = await this.read(record.sourceMessageId);
        if (!source || source.origin !== "human" || source.event.authorId !== record.assertedByUserId ||
            record.sourceTimestampMs != null && source.event.timestampMs !== record.sourceTimestampMs || !source.event.content.includes(record.sourceQuote)) continue;
        if (!await this.retain(record.sourceMessageId)) continue;
        admitted.push({ ...record, statement: record.sourceQuote });
        chars += record.sourceQuote.length;
      }
      return admitted;
    }, "memory");
  }

  public async resource(key: GuardedResourceKey): Promise<string | null> {
    return this.phase(async () => {
      if (!this.port.resource || this.resources.size >= 32) return null;
      const actor = key.kind === "birthday" ? await this.port.actor(key.id, this.signal) : null;
      if (key.kind === "birthday" && !actor) return null;
      const value = await this.port.resource(key, this.signal).catch(() => null);
      if (value === null || value.length > 16000) return null;
      if (actor) this.reactionActors.set(actor.id, actor);
      const entry = { ...key, representationHash: hashContent(value) };
      const prior = this.resources.get(`${key.kind}:${key.id}`);
      if (prior && prior.representationHash !== entry.representationHash) throw new SocialOutputSuppressed();
      this.resources.set(`${key.kind}:${key.id}`, entry); return value;
    }, "memory");
  }

  public async images(limit: number): Promise<ChatImage[]> {
    if (!this.port.loadAsset || !Number.isFinite(limit) || limit < 1) return [];
    return this.phase(async () => {
      const images: ChatImage[] = [];
      const chainIds = new Set(this.replyChain.map((event) => event.messageId));
      const candidates = [...new Map([this.current, ...[...this.replyChain].reverse(), ...[...this.history].reverse()].map((event) => [event.messageId, event])).values()];
      for (const event of candidates) {
        const source = await this.read(event.messageId); if (!source) continue;
        const assets = source.assets ?? [];
        // A text-only bot origin cannot certify an attached image.
        if (source.origin === "chat" && source.provenance?.outputAssetsHash !== guardedAssetsHash(assets)) continue;
        for (const asset of assets) {
          if (images.length >= Math.min(4, limit)) return images;
          if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.contentType)) continue;
          const dataUrl = await this.port.loadAsset!(event.messageId, asset.id, AbortSignal.any([this.signal, AbortSignal.timeout(3000)])).catch(() => null);
          if (!dataUrl || dataUrl.length > 12_000_000 || !dataUrl.startsWith(`data:${asset.contentType};base64,`)) continue;
          this.assetDependencies.set(event.messageId, guardedAssetsHash(assets));
          for (const projected of new Set([this.current, ...this.replyChain, ...this.history, ...this.burst])) if (projected.messageId === event.messageId) projected.imageCount++;
          images.push(Object.freeze({ dataUrl, source: event.messageId === this.current.messageId ? "current_message" : chainIds.has(event.messageId) ? "reply_chain" : "channel_history",
            sourceMessageId: event.messageId, sourceIndex: images.length }));
        }
      }
      return images;
    }, "assets");
  }

  public async validate(): Promise<boolean> {
    if (++this.passes > guardedContextLimits.maxValidationPasses) { this.closed = true; this.port.validation?.("bounded", this.reads); return false; }
    try { const valid = await this.phase(async () => {
      const entries = [...this.evidence];
      await this.port.prepareValidation?.(entries.map(([id]) => id), this.signal);
      for (let index = 0; index < entries.length; index += 4) {
        const results = await Promise.all(entries.slice(index, index + 4).map(async ([id, previous]) => {
          const source = await this.read(id); return !!source && same(previous, source.event);
        }));
        if (results.some((result) => !result)) return false;
      }
      for (const [id, previous] of this.reactionActors) {
        const actor = await this.port.actor(id, this.signal); if (!actor || JSON.stringify(actor) !== JSON.stringify(previous)) return false;
      }
      if (!await this.validateResources({ resources: [...this.resources.values()] })) return false;
      return this.port.policyCurrent();
    }, "validation");
      if (!valid) this.closed = true;
      this.port.validation?.(valid ? "current" : "changed", this.reads); return valid;
    } catch { this.closed = true; this.port.validation?.(this.report.status === "deadline" ? "deadline" : "bounded", this.reads); return false; }
  }

  private inheritPublicTools(proof: ContextProvenance | null | undefined): void {
    for (const entry of proof?.publicTools ?? []) this.publicTools.set(`${entry.name}:${entry.outputHash}`, entry);
  }

  public recordPublicTool(name: string, output: string): void {
    if (this.closed || !this.port.policyCurrent() || this.publicTools.size >= 128) throw new SocialOutputSuppressed();
    const entry = { name, outputHash: hashContent(output) }; this.publicTools.set(`${name}:${entry.outputHash}`, entry);
  }

  public recordPublicWebSearch(sources: readonly ChatSource[]): ChatSource[] {
    this.publicWebUsed = true;
    const selected = publicWebSources(sources);
    for (const source of selected) this.publicWebCitations.add(hashContent(source.url));
    return selected;
  }

  public provenance(output: string, purpose: "reply" | "memory_claim" | "character_state" = "reply"): ContextProvenance | null {
    if (this.port.persist === false || this.closed || !this.port.policyCurrent() || !this.evidence.size || this.evidence.size > contextProvenanceLimits.dependencies) return null;
    return parseContextProvenance({ version: 1, ...(purpose !== "reply" ? { purpose } : {}), coverage: "complete", audience: { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.audienceUserId ?? null },
      outputHash: hashContent(output), dependencies: [...this.evidence.values()].map((source) => ({ guildId: this.port.guildId,
        channelId: this.port.channelId, messageId: source.messageId, authorId: source.authorId, timestampMs: source.timestampMs,
        representationHash: contextSourceHash(source), ...(this.assetDependencies.has(source.messageId) ? { assetsHash: this.assetDependencies.get(source.messageId) } : {}) })), actors: [...this.reactionActors.values()].map((actor) => ({ userId: actor.id, representationHash: hashContent(JSON.stringify(actor)) })),
      ...(this.publicTools.size ? { publicTools: [...this.publicTools.values()] } : {}),
      ...(this.resources.size ? { resources: [...this.resources.values()] } : {}),
      ...(this.publicWebUsed ? { publicWeb: { citationHashes: [...this.publicWebCitations].sort() } } : {}), unresolved: [] });
  }
}

// Same grounding anchors, independently bounded decision projection.
export function projectDecisionContext(request: ChatRequest, count: number): ChannelHistoryMessage[] {
  const anchors = [...request.replyChain]; const ids = new Set(anchors.map((event) => event.messageId));
  const slots = Math.max(0, count - anchors.length);
  const recent = slots ? request.channelHistory.filter((event) => !ids.has(event.messageId)).slice(-slots) : [];
  return [...anchors, ...recent].slice(-Math.max(count, anchors.length));
}
