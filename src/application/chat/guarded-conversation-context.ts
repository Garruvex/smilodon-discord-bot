import { hashContent } from "../assets/content-hash.js";
import type { ChannelHistoryMessage, ChatImage, ChatRequest, ChatSource, ChatUser, ConversationEvent } from "./chat-provider.js";
import { publicWebSources } from "./public-web-sources.js";
import { memoryClaimProof } from "../memory/memory-claim-provenance.js";
import { canRecall, canRecallOrdinaryMemory, type Memory, type MemorySource, type MemoryRelation } from "../memory/memory.js";
import { memoryRelationPayload, memoryRelationProof } from "../memory/memory-relation-provenance.js";
import { explicitSelfAlias, memoryAliasPayload, memoryAliasProof, type AliasScope } from "../memory/memory-alias-provenance.js";
import { aliasQueryTokens, observedSubjectNames, type ObservedSubjectName } from "../memory/observed-subject-names.js";
import type { ChatSessionExchange } from "./chat-state-store.js";
import { budgetEligibleHistory } from "./eligible-channel-history.js";
import { actorSourceHash, humanTextSourceHash, contextProvenanceLimits, dependencyMatchesSource, parseContextProvenance, parseScopedContextProvenance, type ContextProvenance } from "./context-provenance.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { immutableSnapshot } from "../context/immutable-snapshot.js";
import { isConversationSource } from "../context/conversation-source-registry.js";

export const guardedContextLimits = { pageSize: 100, pages: 3, targetedPages: 5, replyDepth: 20, overflowDepth: 40, overflowChars: 12000, messageChars: 4000, replyChars: 6000, burstMessages: 16, burstChars: 6000, targetedMessages: 8,
  dependencies: 128, sourceReads: 4096, workMs: 20_000, phaseMs: 8_000, maxValidationPasses: 64 } as const;
export interface GuardedContextSource {
  sourceMessageId?: string | null;
  assets?: readonly GuardedAssetDescriptor[];
  event: ChannelHistoryMessage;
  origin: "human" | "chat" | "other";
  provenance: ContextProvenance | null;
}
export interface GuardedAssetDescriptor { id: string; contentType: string; size: number }
export const guardedAssetsHash = (assets: readonly GuardedAssetDescriptor[]): string => hashContent(JSON.stringify(
  [...assets].map(({ id, contentType, size }) => ({ id, contentType, size })).sort((a, b) => a.id.localeCompare(b.id))));
export interface GuardedContextPort {
  evidenceChanged?: () => boolean;
  refresh?: () => Promise<GuardedContextPort>;
  // Reviewed Discord adapters may own one immutable, event-invalidated snapshot.
  // Other adapters retain full source revalidation by default.
  snapshotCurrent?: (effect: boolean, signal: AbortSignal, sourceIds: readonly string[]) => Promise<boolean>;
  retention?: "durable" | "session" | "none";
  shareMemory?: boolean;
  turnSignal?: AbortSignal;
  resource?: (key: GuardedResourceKey, signal: AbortSignal) => Promise<string | null>;
  work?: (phase: GuardedContextPhase, status: "completed" | "deadline" | "failed", durationMs: number) => void;
  loadAsset?: (messageId: string, assetId: string, signal: AbortSignal) => Promise<string | null>;
  persist?: boolean;
  audienceUserId?: string | null;
  coverage?: (report: GuardedContextReport) => void;
  validation?: (status: "current" | "changed" | "deadline" | "bounded", reads: number, mode?: "full" | "snapshot" | "effect") => void;
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
export type GuardedContextPhase = "assembly" | "sessions" | "memory" | "assets" | "relations" | "identities" | "validation";
export interface GuardedContextReport {
  replyChain: number; replyOverflow: number; replyBounded: boolean; burst: number; eligibleReactors: number; omittedReactors: number;
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
const sourceVersion = (source: GuardedContextSource): string => hashContent(JSON.stringify({ origin: source.origin, sourceMessageId: source.sourceMessageId ?? null, provenance: source.provenance }));
export const contextSourceHash = (event: ChannelHistoryMessage): string => hashContent(JSON.stringify({
  content: event.content, author: event.author, authorId: event.authorId, timestampMs: event.timestampMs, replyToMessageId: event.replyToMessageId,
}));
const compact = (event: ChannelHistoryMessage): ChannelHistoryMessage => ({ ...event, imageCount: 0,
  content: event.content.slice(0, guardedContextLimits.messageChars), ...(event.content.length > guardedContextLimits.messageChars ? { contentTruncated: true } : {}) });

// This lease is registered at runtime, owns source resolution, and issues
// complete text provenance only for the closed, whitelisted assembly below.
// It is deliberately narrower than the separately planned universal gateway.
export class GuardedConversationContext {
  public hasForgottenSource(cutoff: (userId: string) => number | undefined): boolean {
    return [...this.evidence.values()].some((source) => source.timestampMs <= (cutoff(source.authorId) ?? -Infinity));
  }
  public get durableWritesAllowed(): boolean { return !this.closed && this.port.persist !== false && this.port.policyCurrent(); }
  public get sharedMemoryAllowed(): boolean { return this.durableWritesAllowed && this.port.shareMemory === true; }
  public get scope(): Readonly<{ guildId: string; channelId: string; actorId: string | null }> { return Object.freeze({ guildId: this.port.guildId, channelId: this.port.channelId, actorId: this.port.actorId }); }
  public get cancellationSignal(): AbortSignal | undefined { return this.port.turnSignal; }
  public get admittedActorIds(): readonly string[] { return Object.freeze([...new Set([...this.reactionActors.keys(), ...this.identityActors])]); }
  private remainingMs: number = guardedContextLimits.workMs;
  private reads = 0;
  private passes = 0;
  private closed = false;
  private cache = new Map<string, Promise<GuardedContextSource | null>>();
  private signal = new AbortController().signal;
  private readonly evidence = new Map<string, ChannelHistoryMessage>();
  private readonly evidenceVersions = new Map<string, string>();
  private readonly evidenceAssets = new Map<string, readonly GuardedAssetDescriptor[]>();
  private publicWebUsed = false;
  private readonly publicWebCitations = new Set<string>();
  private readonly publicTools = new Map<string, { name: string; outputHash: string }>();
  private readonly resources = new Map<string, NonNullable<ContextProvenance["resources"]>[number]>();
  private readonly assetDependencies = new Map<string, string>();
  private phaseQueue: Promise<void> = Promise.resolve();
  private readonly coverageReport: GuardedContextReport = { replyChain: 0, replyOverflow: 0, replyBounded: false, burst: 0, eligibleReactors: 0, omittedReactors: 0, requested: 40, fetched: 0, examined: 0, duplicates: 0, unverifiedBot: 0, invalidatedDerived: 0, selectedIds: [], oldestTimestampMs: null, newestTimestampMs: null, eligible: 0, selected: 0, pages: 0, targetedPages: 0,
    omitted: 0, truncated: 0, sourceReads: 0, status: "end" };
  private sourceCurrent!: ChannelHistoryMessage;
  private sourceHistory: ChannelHistoryMessage[] = [];
  private sourceReplyChain: ChannelHistoryMessage[] = [];
  private sourceReplyOverflow: ChannelHistoryMessage[] = [];
  private readonly sessionQueries = new Map<string, { content: string; timestampMs: number }>();
  private sourceBurst: ChannelHistoryMessage[] = [];
  private sourceEvent: ConversationEvent | undefined;
  private reactionActors = new Map<string, ChatUser>();
  private readonly identityActors = new Set<string>();
  private aliasObservationIncomplete = false;
  private readonly port: Readonly<GuardedContextPort>;
  private constructor(port: GuardedContextPort) { this.port = Object.freeze({ ...port }); registered.add(this); Object.seal(this); }
  public get current(): ChannelHistoryMessage { return immutableSnapshot(this.sourceCurrent); }
  public get history(): ChannelHistoryMessage[] { return immutableSnapshot(this.sourceHistory); }
  public get replyChain(): ChannelHistoryMessage[] { return immutableSnapshot(this.sourceReplyChain); }
  public get replyOverflow(): ChannelHistoryMessage[] { return immutableSnapshot(this.sourceReplyOverflow); }
  public get retrievalHistory(): readonly { content: string }[] {
    const messages = new Map(this.sourceHistory.map((event) => [event.messageId, { content: event.content, timestampMs: event.timestampMs }]));
    for (const [id, event] of this.sessionQueries) messages.set(id, event);
    return immutableSnapshot([...messages.values()].sort((left, right) => left.timestampMs - right.timestampMs).slice(-2).map(({ content }) => ({ content })));
  }
  public get burst(): ChannelHistoryMessage[] { return immutableSnapshot(this.sourceBurst); }
  public get currentEvent(): ConversationEvent | undefined { return this.sourceEvent ? immutableSnapshot(this.sourceEvent) : undefined; }
  public get report(): GuardedContextReport { return immutableSnapshot(this.coverageReport); }

  private phase<T>(operation: () => Promise<T>, phase: GuardedContextPhase = "assembly"): Promise<T> {
    const work = this.phaseQueue.then(() => this.runPhase(operation, phase));
    this.phaseQueue = work.then(() => undefined, () => undefined); return work;
  }
  private async runPhase<T>(operation: () => Promise<T>, phase: GuardedContextPhase): Promise<T> {
    if (this.closed || !this.port.policyCurrent() || this.remainingMs <= 0) throw new SocialOutputSuppressed();
    const controller = new AbortController(); this.signal = controller.signal;
    if (!this.port.snapshotCurrent) this.cache = new Map();
    const started = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    let status: "completed" | "deadline" | "failed" = "failed";
    try {
      const result = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { status = "deadline"; this.closed = true; controller.abort(); this.coverageReport.status = "deadline"; reject(new SocialOutputSuppressed()); },
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
    this.coverageReport.sourceReads = this.reads;
    const next = new Set(path).add(id);
    const pending = (async (): Promise<GuardedContextSource | null> => {
      const raw = await this.port.read(id, this.signal).catch(() => null);
      const source = raw ? immutableSnapshot(raw) : null;
      if (!source || source.event.channelId !== this.port.channelId || source.event.messageId !== id || source.origin === "other") return null;
      if (source.event.author && source.event.author.id !== source.event.authorId) return null;
      if (this.assetDependencies.has(id) && guardedAssetsHash(source.assets ?? []) !== this.assetDependencies.get(id)) return null;
      if (source.origin === "chat") {
        const proof = parseScopedContextProvenance(source.provenance, { guildId: this.port.guildId, channelId: this.port.channelId,
          ...(this.port.actorId ? { userId: this.port.actorId } : {}) });
        if (!proof || proof.purpose && proof.purpose !== "reply" || proof.coverage !== "complete") { this.coverageReport.unverifiedBot++; return null; }
        if (proof.outputHash !== hashContent(source.event.content)) { this.coverageReport.invalidatedDerived++; return null; }
        if (proof.outputAssetsHash && proof.outputAssetsHash !== guardedAssetsHash(source.assets ?? [])) return null;
        await this.port.prepareValidation?.(proof.dependencies.filter((dependency) => dependency.guildId === this.port.guildId && dependency.channelId === this.port.channelId).map((dependency) => dependency.messageId), this.signal).catch(() => undefined);
        if (!await this.proofSourcesCurrent(proof, next)) { this.coverageReport.invalidatedDerived++; return null; }
      }
      return source;
    })();
    this.cache.set(id, pending); return pending;
  }

  private async retain(id: string): Promise<ChannelHistoryMessage | null> {
    const source = await this.read(id); if (!source) { this.coverageReport.omitted++; return null; }
    const add = async (item: GuardedContextSource): Promise<boolean> => {
      if (this.evidence.has(item.event.messageId)) {
        if (this.evidenceVersions.get(item.event.messageId) !== sourceVersion(item)) throw new SocialOutputSuppressed();
        this.evidenceAssets.set(item.event.messageId, immutableSnapshot(item.assets ?? []));
        return true;
      }
      if (!this.evidence.has(item.event.messageId) && this.evidence.size >= guardedContextLimits.dependencies) return false;
      this.evidence.set(item.event.messageId, item.event);
      this.evidenceVersions.set(item.event.messageId, sourceVersion(item));
      this.evidenceAssets.set(item.event.messageId, immutableSnapshot(item.assets ?? []));
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
      for (const key of this.evidence.keys()) if (!before.has(key)) { this.evidence.delete(key); this.evidenceVersions.delete(key); this.evidenceAssets.delete(key); }
      this.coverageReport.omitted++; return null;
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

  public static async open(port: GuardedContextPort, input: { count: number; budget: number; minReactors?: number; burstIds: readonly string[]; event?: ConversationEvent; collectOverflow?: boolean }): Promise<GuardedConversationContext> {
    if (!isConversationSource(port)) throw new SocialOutputSuppressed();
    const lease = new GuardedConversationContext(port); port = lease.port;
    input = immutableSnapshot(input); lease.coverageReport.requested = input.count;
    try { await lease.phase(async () => {
      const current = await lease.retain(port.sourceMessageId); if (!current) { lease.coverageReport.status = "source_ineligible"; throw new SocialOutputSuppressed(); }
      if (port.actorId !== null && port.actorId !== current.authorId) throw new SocialOutputSuppressed();
      if (input.event?.type === "reaction_snapshot" && (input.event.targetMessageId !== current.messageId || input.event.channelId !== port.channelId ||
        input.event.targetAuthorId !== current.authorId || (await lease.read(current.messageId))?.origin !== "chat")) throw new SocialOutputSuppressed();
      lease.sourceCurrent = current;
      lease.sourceEvent = input.event?.type === "reaction_snapshot" ? input.event : { type: "message", messageId: current.messageId,
        channelId: port.channelId, authorId: current.authorId, timestampMs: current.timestampMs,
        replyToMessageId: current.replyToMessageId ?? null, mentionedUserIds: [...current.content.matchAll(/<@!?(\d+)>/gu)].map((match) => match[1]!) };
      const ancestors: ChannelHistoryMessage[] = []; let reference = current.replyToMessageId;
      const visited = new Set([current.messageId]);
      for (let depth = 0; reference && depth < guardedContextLimits.replyDepth && !visited.has(reference); depth++) {
        visited.add(reference); const source = await lease.read(reference); if (!source) { lease.coverageReport.omitted++; break; }
        const parent = compact(source.event); ancestors.push(parent); reference = parent.replyToMessageId;
      }
      lease.sourceReplyChain = [];
      const boundedReply = budgetEligibleHistory(ancestors.reverse(), guardedContextLimits.replyDepth, guardedContextLimits.replyChars);
      lease.coverageReport.truncated += boundedReply.truncated; lease.coverageReport.omitted += boundedReply.budgetOmitted;
      for (const event of boundedReply.messages) if (await lease.retain(event.messageId)) lease.sourceReplyChain.push(event);
      lease.coverageReport.replyChain = lease.sourceReplyChain.length;
      const keptIds = new Set(lease.sourceReplyChain.map((event) => event.messageId));
      const overflow = ancestors.filter((event) => !keptIds.has(event.messageId)); const older: ChannelHistoryMessage[] = [];
      for (let depth = 0; input.collectOverflow && reference && depth < guardedContextLimits.overflowDepth && !visited.has(reference); depth++) {
        visited.add(reference); const source = await lease.read(reference); if (!source) break;
        older.push(compact(source.event)); reference = source.event.replyToMessageId;
      }
      const boundedOverflow = budgetEligibleHistory([...older.reverse(), ...overflow], guardedContextLimits.overflowDepth, guardedContextLimits.overflowChars);
      if (input.collectOverflow) for (const event of boundedOverflow.messages) if (await lease.retain(event.messageId)) lease.sourceReplyOverflow.push(event);
      lease.coverageReport.replyOverflow = lease.sourceReplyOverflow.length;
      lease.coverageReport.replyBounded = !!reference || lease.sourceReplyOverflow.length > 0 || boundedReply.budgetOmitted > 0 || boundedReply.truncated > 0 || boundedOverflow.countOmitted > 0 || boundedOverflow.budgetOmitted > 0;
      for (const id of [...new Set(input.burstIds)].slice(-guardedContextLimits.burstMessages)) {
        const source = await lease.read(id); const event = source ? compact(source.event) : null; if (event && event.authorId === current.authorId && id !== current.messageId) lease.sourceBurst.push(event);
      }
      if (lease.sourceEvent.type === "message") lease.sourceBurst.push(current);
      const boundedBurst = budgetEligibleHistory(lease.sourceBurst, guardedContextLimits.burstMessages, guardedContextLimits.burstChars);
      lease.sourceBurst = [];
      for (const event of boundedBurst.messages) if (await lease.retain(event.messageId)) lease.sourceBurst.push(event);
      lease.coverageReport.truncated += boundedBurst.truncated; lease.coverageReport.omitted += boundedBurst.budgetOmitted;
      lease.coverageReport.burst = lease.sourceBurst.length;
      const exclude = new Set([current.messageId, ...lease.sourceReplyChain.map((event) => event.messageId), ...lease.sourceReplyOverflow.map((event) => event.messageId), ...lease.sourceBurst.map((event) => event.messageId)]);
      const candidates: ChannelHistoryMessage[] = []; let cursor: string | null = lease.sourceEvent.type === "reaction_snapshot" ? null : current.messageId;
      const backward = /\b(?:earlier|previous|above|before)\b|之前|前面|上面|剛剛|さっき|前の/iu.test(current.content);
      const maxPages = guardedContextLimits.pages + (backward ? guardedContextLimits.targetedPages : 0);
      for (let page = 0; input.count > 0 && page < maxPages; page++) {
        let ids: readonly string[];
        try { ids = (await port.page(cursor, lease.signal)).slice(0, guardedContextLimits.pageSize); }
        catch { lease.coverageReport.status = "fetch_failed"; break; }
        if (page < guardedContextLimits.pages) lease.coverageReport.pages++; else lease.coverageReport.targetedPages++;
        lease.coverageReport.fetched += ids.length;
        for (const id of ids) {
          lease.coverageReport.examined++;
          if (exclude.has(id) || candidates.some((event) => event.messageId === id)) { lease.coverageReport.duplicates++; continue; }
          const source = await lease.read(id); if (!source) { lease.coverageReport.omitted++; continue; }
          lease.coverageReport.eligible++; candidates.push(compact(source.event));
          if (candidates.length >= input.count && !backward) break;
        }
        const next = ids.at(-1);
        if (candidates.length >= input.count && !backward) { lease.coverageReport.status = "filled"; break; }
        if (ids.length < guardedContextLimits.pageSize || !next) { lease.coverageReport.status = "end"; break; }
        if (next === cursor) { lease.coverageReport.status = "no_progress"; break; }
        cursor = next; lease.coverageReport.status = "scan_cap";
      }
      // A backward reference adds a bounded relevance search; it does not
      // turn every mention into a scan of the channel's entire history.
      const baseline = candidates.slice(0, input.count);
      const terms = current.content.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
      const targeted = backward ? candidates.slice(input.count).map((event) => ({ event, score:
        terms.reduce((total, term) => total + Number(event.content.toLowerCase().includes(term)), 0) * 2 + Number(event.authorId === current.authorId) }))
        .filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, guardedContextLimits.targetedMessages).map((item) => item.event) : [];
      const bounded = budgetEligibleHistory([...baseline, ...targeted], input.count + targeted.length, input.budget);
      lease.coverageReport.truncated += bounded.truncated; lease.sourceHistory = [];
      for (const event of bounded.messages) if (await lease.retain(event.messageId)) lease.sourceHistory.push(event);
      lease.coverageReport.selected = lease.sourceHistory.length;
      lease.coverageReport.omitted += Math.max(0, candidates.length - lease.sourceHistory.length);
      lease.coverageReport.selectedIds = lease.sourceHistory.map((event) => event.messageId);
      lease.coverageReport.oldestTimestampMs = lease.sourceHistory[0]?.timestampMs ?? null;
      lease.coverageReport.newestTimestampMs = lease.sourceHistory.at(-1)?.timestampMs ?? null;
      if (lease.sourceEvent.type === "reaction_snapshot") {
        const reactions = [];
        for (const reaction of lease.sourceEvent.reactions.slice(0, 20)) {
          const actorIds = [];
          for (const id of reaction.actorIds.slice(0, 100)) {
            if (!lease.canRetainActor(id)) { lease.coverageReport.omittedReactors++; continue; }
            const actor = await port.actor(id, lease.signal); if (!actor || actor.id !== id) { lease.coverageReport.omittedReactors++; continue; }
            if (lease.retainActor(actor)) actorIds.push(id); else lease.coverageReport.omittedReactors++;
          }
          if (actorIds.length) reactions.push({ ...reaction, actorIds });
        }
        lease.coverageReport.eligibleReactors = lease.reactionActors.size;
        if (lease.reactionActors.size < (input.minReactors ?? 1)) { lease.coverageReport.status = "ineligible_reaction"; throw new SocialOutputSuppressed(); }
        lease.sourceEvent = { ...lease.sourceEvent, reactions };
      }
      const selected = new Map([current, ...lease.sourceReplyChain, ...lease.sourceHistory, ...lease.sourceBurst].map((event) => [event.messageId, event]));
      for (const event of selected.values()) {
        const target = event.replyToMessageId ? selected.get(event.replyToMessageId) : null;
        event.replyToAuthorId = target?.authorId ?? null;
        event.replyToAuthorDisplayName = target?.authorDisplayName ?? null;
      }
    }); } finally { port.coverage?.({ ...lease.coverageReport }); }
    return lease;
  }

  public async sessions(exchanges: readonly ChatSessionExchange[]): Promise<ChatSessionExchange[]> {
    return this.phase(async () => {
      const selected: ChatSessionExchange[] = [];
      if (!this.port.actorId || this.sourceEvent?.type === "reaction_snapshot") return selected;
      const actorId = this.port.actorId;
      const candidates = exchanges.slice(-4).flatMap((exchange) => {
        const proof = parseScopedContextProvenance(exchange.contextProvenance, { guildId: this.port.guildId, channelId: this.port.channelId, userId: actorId });
        const sourceId = exchange.user.sourceMessageId; const deliveryIds = exchange.assistant.messageIds;
        if (proof ? proof.purpose && proof.purpose !== "reply" || proof.coverage !== "complete" || proof.outputHash !== hashContent(exchange.assistant.content)
          : exchange.contextProvenance != null || this.port.retention !== "session") return [];
        if (!sourceId || !deliveryIds?.length || deliveryIds.length > 32 || new Set(deliveryIds).size !== deliveryIds.length ||
            exchange.user.content.length > 1000 || exchange.assistant.content.length > 2000) return [];
        return [{ exchange, proof, sourceId, deliveryIds }];
      });
      if (!candidates.length) return selected;
      await this.port.prepareValidation?.([...new Set([this.sourceCurrent.messageId, ...candidates.flatMap(({ proof, sourceId, deliveryIds }) =>
        [sourceId, ...deliveryIds, ...(proof?.dependencies.map((dependency) => dependency.messageId) ?? [])])])], this.signal);
      for (const { exchange, proof, sourceId, deliveryIds } of candidates) {
        const human = await this.read(sourceId);
        if (!human || human.origin !== "human" || human.event.authorId !== this.port.actorId || !human.event.content.startsWith(exchange.user.content)) continue;
        let valid = proof ? await this.proofSourcesCurrent(proof) : true;
        let delivered = "";
        let lastTime = -Infinity;
        for (const id of deliveryIds) {
          const source = await this.read(id);
          if (!source || source.origin !== "chat" || (!proof || source.sourceMessageId !== undefined) && source.sourceMessageId !== sourceId ||
              source.event.timestampMs < lastTime) { valid = false; break; }
          lastTime = source.event.timestampMs; delivered += source.event.content;
        }
        const normalized = (value: string): string => value.replace(/\s+/gu, "");
        if (!valid || !normalized(delivered).includes(normalized(exchange.assistant.content))) continue;
        for (const id of [...(proof?.dependencies.map((source) => source.messageId) ?? []), ...deliveryIds, sourceId]) if (!await this.retain(id)) valid = false;
        if (valid) {
          if (proof && !await this.retainActors(proof)) continue;
          for (const entry of proof?.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
          for (const dependency of proof?.dependencies ?? []) if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
          selected.push(immutableSnapshot(exchange));
          this.sessionQueries.set(sourceId, { content: exchange.user.content, timestampMs: exchange.user.createdAt });
          this.sessionQueries.set(deliveryIds[0]!, { content: exchange.assistant.content, timestampMs: exchange.assistant.createdAt });
          while (this.sessionQueries.size > 8) this.sessionQueries.delete(this.sessionQueries.keys().next().value!);
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
          if (!valid) { for (const id of this.evidence.keys()) if (!before.has(id)) { this.evidence.delete(id); this.evidenceVersions.delete(id); this.evidenceAssets.delete(id); } continue; }
          for (const dependency of proof.dependencies) if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
          if (subject && !this.retainActor(subject)) continue;
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

  private canRetainActor(id: string): boolean {
    return this.reactionActors.has(id) || this.identityActors.has(id) || this.admittedActorIds.length < 100;
  }
  private retainActor(actor: ChatUser, identityOnly = false): boolean {
    if (!this.canRetainActor(actor.id)) return false;
    if (identityOnly) { this.identityActors.add(actor.id); return true; }
    const prior = this.reactionActors.get(actor.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(actor)) throw new SocialOutputSuppressed();
    this.reactionActors.set(actor.id, immutableSnapshot(actor)); return true;
  }
  private async retainActors(proof: ContextProvenance): Promise<boolean> {
    for (const entry of proof.actors ?? []) {
      const actor = await this.port.actor(entry.userId, this.signal);
      if (!actor || actor.id !== entry.userId || actorSourceHash(actor, entry.projection) !== entry.representationHash) return false;
      if (!this.retainActor(actor, entry.projection === "identity")) return false;
    }
    return true;
  }

  private async proofSourcesCurrent(proof: ContextProvenance, path = new Set<string>()): Promise<boolean> {
    const actorIds = new Set([...this.admittedActorIds, ...(proof.actors ?? []).map((actor) => actor.userId)]);
    const resourceIds = new Set([...this.resources.keys(), ...(proof.resources ?? []).map((entry) => `${entry.kind}:${entry.id}`)]);
    if (actorIds.size > 100 || resourceIds.size > 32) return false;
    if (proof.coverage !== "complete" || proof.audience.guildId !== this.port.guildId || proof.audience.channelId !== this.port.channelId ||
        proof.audience.userId !== null && proof.audience.userId !== this.port.audienceUserId || !await this.validateResources(proof)) return false;
    for (const dependency of proof.actors ?? []) {
      const actor = await this.port.actor(dependency.userId, this.signal);
      if (!actor || actor.id !== dependency.userId || actorSourceHash(actor, dependency.projection) !== dependency.representationHash) return false;
    }
    for (const dependency of proof.dependencies) {
      if (dependency.guildId !== this.port.guildId || dependency.channelId !== this.port.channelId) return false;
      const source = await this.read(dependency.messageId, path);
      if (dependency.projection?.kind === "human_text" && source?.origin !== "human") return false;
      if (!source || !dependencyMatchesSource(dependency, source.event, contextSourceHash(source.event)) ||
          dependency.assetsHash && dependency.assetsHash !== guardedAssetsHash(source.assets ?? [])) return false;
    }
    return true;
  }

  public async participants(ids: readonly string[]): Promise<ChatUser[]> {
    return this.phase(() => this.resolveParticipants(ids), "identities");
  }

  private async resolveParticipants(ids: readonly string[]): Promise<ChatUser[]> {
      const admitted: ChatUser[] = [];
      for (const id of [...new Set(ids)].slice(0, 100)) {
        if (!this.canRetainActor(id)) continue;
        const actor = await this.port.actor(id, this.signal); if (!actor || actor.id !== id) continue;
        if (this.retainActor(actor)) admitted.push(immutableSnapshot(actor));
      }
      return admitted;
  }

  public async observeAliases(scope: AliasScope, requested: readonly string[], now: number): Promise<ObservedSubjectName[]> {
    return this.phase(async () => {
      if (scope.guildId !== this.port.guildId || scope.subjectType !== "member" || scope.channelId !== null && scope.channelId !== this.port.channelId ||
          scope.isolationChannelId !== null && scope.isolationChannelId !== this.port.channelId ||
          this.port.audienceUserId && scope.audience === "private" && scope.ownerUserId !== this.port.audienceUserId) return [];
      const actor = await this.port.actor(scope.subjectId, this.signal); if (!actor || actor.id !== scope.subjectId) return [];
      const profileNames = [actor.displayName, actor.username, actor.globalName, actor.guildNickname].filter((name): name is string => !!name);
      const names = [...new Set([...requested, ...profileNames].map((name) => name.trim()).filter((name) => name.length >= 2 && name.length <= 100))].slice(0, 16);
      const admitted: ObservedSubjectName[] = [];
      for (const value of names) {
        let dependency: ContextProvenance["dependencies"][number] | null = null;
        for (const [id, event] of this.evidence) {
          if (event.authorId !== scope.subjectId || !explicitSelfAlias(event.content, value)) continue;
          const source = await this.read(id); if (!source || source.origin !== "human") continue;
          const content = source.event.content.trim(); if (!content || content.length > 16000) continue;
          dependency = { guildId: this.port.guildId, channelId: this.port.channelId, messageId: id, authorId: scope.subjectId,
            timestampMs: source.event.timestampMs, projection: { kind: "human_text", chars: content.length },
            representationHash: humanTextSourceHash({ authorId: scope.subjectId, content, timestampMs: source.event.timestampMs }) };
          break;
        }
        if (!dependency) {
          const proof = await this.currentProfileAlias(scope, value, actor);
          if (proof && await this.retainActors(proof)) admitted.push({ value, observedAt: now, contextProvenance: proof });
          continue;
        }
        const proof = parseContextProvenance({ version: 1, purpose: "identity_alias", coverage: "complete", unresolved: [],
          audience: { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.audienceUserId ?? (scope.audience === "private" ? scope.ownerUserId : null) },
          outputHash: hashContent(memoryAliasPayload(scope, value)), dependencies: [dependency],
          actors: [{ userId: actor.id, representationHash: actorSourceHash(actor, "identity"), projection: "identity" }],
        });
        if (!proof || !await this.retainActors(proof)) continue;
        admitted.push({ value, observedAt: now, contextProvenance: proof });
      }
      return admitted;
    }, "identities");
  }

  public async aliases(records: readonly Memory[], message: string, now = Date.now()): Promise<{ rows: { alias: string; subjectId: string }[]; sources: Memory[]; incomplete: boolean }> {
    return this.phase(async () => {
      const tokens = new Set(aliasQueryTokens(message)); const admitted: { alias: string; subjectId: string }[] = []; const subjects = new Set<string>();
      let incomplete = this.aliasObservationIncomplete || records.length >= 128; const sources: Memory[] = [];
      for (const record of records.slice(0, 128)) {
        if (record.moduleId || record.subjectType !== "member" || !canRecall(record, { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.actorId ?? "" }, now) ||
            record.audience === "private" && (record.ownerUserId !== this.port.audienceUserId || record.ownerUserId !== this.port.actorId)) continue;
        if (!subjects.has(record.subjectId) && subjects.size >= 32 || !this.canRetainActor(record.subjectId)) { incomplete = true; continue; }
        const actor = await this.port.actor(record.subjectId, this.signal); if (!actor || actor.id !== record.subjectId) continue;
        const names: ObservedSubjectName[] = [];
        for (const name of observedSubjectNames(record)) {
          if (!tokens.has(name.value.toLowerCase())) continue;
          let proof = memoryAliasProof(name.contextProvenance, record, name.value);
          if (!proof || !await this.retainDerived(proof, memoryAliasPayload(record, name.value), "identity_alias")) {
            proof = await this.currentProfileAlias(record, name.value, actor);
            if (!proof || !await this.retainDerived(proof, memoryAliasPayload(record, name.value), "identity_alias")) continue;
          }
          if (!this.retainActor(actor, true)) { incomplete = true; continue; }
          subjects.add(actor.id); admitted.push({ alias: name.value, subjectId: record.subjectId });
          names.push({ ...name, contextProvenance: proof });
        }
        if (names.length) sources.push({ ...record, statement: "", structuredValue: { observedSubjectNames: names }, contextProvenance: null, embedding: null });
      }
      this.aliasObservationIncomplete ||= incomplete;
      return { rows: admitted, sources, incomplete };
    }, "identities");
  }

  private async currentProfileAlias(scope: AliasScope, value: string, actor: ChatUser): Promise<ContextProvenance | null> {
    if (![actor.displayName, actor.username, actor.globalName, actor.guildNickname].includes(value)) return null;
    const current = await this.read(this.sourceCurrent.messageId); if (!current) return null;
    return parseContextProvenance({ version: 1, purpose: "identity_alias", coverage: "complete", unresolved: [],
      audience: { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.audienceUserId ?? (scope.audience === "private" ? scope.ownerUserId : null) },
      outputHash: hashContent(memoryAliasPayload(scope, value)), dependencies: [{ guildId: this.port.guildId, channelId: this.port.channelId,
        messageId: current.event.messageId, authorId: current.event.authorId, timestampMs: current.event.timestampMs, representationHash: contextSourceHash(current.event) }],
      actors: [{ userId: actor.id, representationHash: actorSourceHash(actor) }],
    });
  }

  public async relations(records: readonly MemoryRelation[]): Promise<MemoryRelation[]> {
    return this.phase(async () => {
    const admitted: MemoryRelation[] = [];
    for (const record of records.slice(0, 128)) {
      if (record.guildId !== this.port.guildId || record.channelId !== this.port.channelId ||
          record.isolationChannelId !== null && record.isolationChannelId !== this.port.channelId) continue;
      const proof = memoryRelationProof(record.contextProvenance, record); const payload = memoryRelationPayload(record);
      if (!proof || !payload) continue;
      const members = [...new Set([...(record.fromSubjectType === "member" ? [record.fromSubjectId] : []), ...(record.toSubjectType === "member" ? [record.toSubjectId] : [])])];
      if ((await this.resolveParticipants(members)).length !== members.length || !await this.retainDerived(proof, payload, "relation")) continue;
      admitted.push(record);
    }
    return admitted;
    }, "relations");
  }

  public async derived(value: unknown, output: string, purpose: "character_state" | "relation" | "identity_alias"): Promise<boolean> {
    return this.phase(() => this.retainDerived(value, output, purpose), "memory");
  }

  private async retainDerived(value: unknown, output: string, purpose: "character_state" | "relation" | "identity_alias"): Promise<boolean> {
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

  public async humanCurrent(): Promise<ChannelHistoryMessage | null> {
    return this.phase(async () => {
      const source = await this.read(this.sourceCurrent.messageId);
      return source?.origin === "human" ? immutableSnapshot(this.sourceCurrent) : null;
    }, "memory");
  }

  public async resource(key: GuardedResourceKey): Promise<string | null> {
    return this.phase(async () => {
      if (!this.port.resource || this.resources.size >= 32 && !this.resources.has(`${key.kind}:${key.id}`)) return null;
      const actor = key.kind === "birthday" ? await this.port.actor(key.id, this.signal) : null;
      if (key.kind === "birthday" && (!actor || actor.id !== key.id)) return null;
      const value = await this.port.resource(key, this.signal).catch(() => null);
      if (value === null || value.length > 16000) return null;
      if (actor && !this.retainActor(actor)) return null;
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
      const chainIds = new Set([...this.sourceReplyChain, ...this.sourceReplyOverflow].map((event) => event.messageId));
      const candidates = [...new Map([this.sourceCurrent, ...[...this.sourceReplyChain].reverse(), ...[...this.sourceHistory].reverse(), ...[...this.sourceReplyOverflow].reverse(),
        ...[...this.evidence.values()].reverse()].map((event) => [event.messageId, event])).values()].filter((event) => this.evidenceAssets.get(event.messageId)?.length);
      if (!candidates.length) return images;
      await this.port.prepareValidation?.(candidates.map((event) => event.messageId), this.signal).catch(() => undefined);
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
          for (const projected of new Set([this.sourceCurrent, ...this.sourceReplyChain, ...this.sourceHistory, ...this.sourceReplyOverflow, ...this.sourceBurst])) if (projected.messageId === event.messageId) projected.imageCount++;
          images.push(Object.freeze({ dataUrl, source: event.messageId === this.sourceCurrent.messageId ? "current_message" : chainIds.has(event.messageId) ? "reply_chain" : "channel_history",
            sourceMessageId: event.messageId, sourceIndex: images.length }));
        }
      }
      return images;
    }, "assets");
  }

  public async validate(freshness: "use" | "effect" = "use"): Promise<boolean> {
    const mode = this.port.snapshotCurrent ? freshness === "effect" ? "effect" : "snapshot" : "full";
    if (!this.port.snapshotCurrent && ++this.passes > guardedContextLimits.maxValidationPasses) { this.closed = true; this.port.validation?.("bounded", this.reads, mode); return false; }
    try { const valid = await this.phase(async () => {
      if (this.port.snapshotCurrent) return await this.port.snapshotCurrent(freshness === "effect", this.signal, [...this.evidence.keys()]) &&
        await this.validateResources({ resources: [...this.resources.values()] }) && this.port.policyCurrent();
      const entries = [...this.evidence];
      await this.port.prepareValidation?.(entries.map(([id]) => id), this.signal);
      for (let index = 0; index < entries.length; index += 4) {
        const results = await Promise.all(entries.slice(index, index + 4).map(async ([id, previous]) => {
          const source = await this.read(id); return !!source && same(previous, source.event) && this.evidenceVersions.get(id) === sourceVersion(source);
        }));
        if (results.some((result) => !result)) return false;
      }
      for (const [id, previous] of this.reactionActors) {
        const actor = await this.port.actor(id, this.signal); if (!actor || actor.id !== id || JSON.stringify(actor) !== JSON.stringify(previous)) return false;
      }
      for (const id of this.identityActors) if ((await this.port.actor(id, this.signal))?.id !== id) return false;
      if (!await this.validateResources({ resources: [...this.resources.values()] })) return false;
      return this.port.policyCurrent();
    }, "validation");
      if (!valid) this.closed = true;
      this.port.validation?.(valid ? "current" : "changed", this.reads, mode); return valid;
    } catch { this.closed = true; this.port.validation?.(this.coverageReport.status === "deadline" ? "deadline" : "bounded", this.reads, mode); return false; }
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

  public provenance(output: string, purpose: "reply" | "memory_claim" | "character_state" | "relation" | "identity_alias" = "reply"): ContextProvenance | null {
    return this.buildProvenance(output, purpose, false);
  }
  public sessionProvenance(output: string): ContextProvenance | null {
    return this.port.retention === "session" ? this.buildProvenance(output, "reply", true) : null;
  }
  private buildProvenance(output: string, purpose: "reply" | "memory_claim" | "character_state" | "relation" | "identity_alias", session: boolean): ContextProvenance | null {
    if (this.port.persist === false && !session || this.closed || !this.port.policyCurrent() || !this.evidence.size || this.evidence.size > contextProvenanceLimits.dependencies) return null;
    return parseContextProvenance({ version: 1, ...(purpose !== "reply" ? { purpose } : {}), coverage: "complete", audience: { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.audienceUserId ?? null },
      outputHash: hashContent(output), dependencies: [...this.evidence.values()].map((source) => ({ guildId: this.port.guildId,
        channelId: this.port.channelId, messageId: source.messageId, authorId: source.authorId, timestampMs: source.timestampMs,
        representationHash: contextSourceHash(source), ...(this.assetDependencies.has(source.messageId) ? { assetsHash: this.assetDependencies.get(source.messageId) } : {}) })), actors: [
          ...[...this.reactionActors.values()].map((actor) => ({ userId: actor.id, representationHash: actorSourceHash(actor) })),
          ...[...this.identityActors].filter((id) => !this.reactionActors.has(id)).map((id) => ({ userId: id, projection: "identity" as const, representationHash: hashContent(JSON.stringify({ id })) })),
        ],
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
