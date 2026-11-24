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
import { actorSourceHash, humanTextSourceHash, contextProvenanceLimits, dependencyMatchesSource, graphAncestryOnly, parseContextProvenance, parseScopedContextProvenance, type ContextProvenance } from "./context-provenance.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import type { ProvenanceArtifactKind, ProvenanceInput } from "../provenance/provenance-graph.js";
import type { ProvenanceCandidate, ProvenanceDecision, ProvenanceReaderKind, ProvenanceReaderMode } from "../provenance/provenance-admission.js";
import { immutableSnapshot } from "../context/immutable-snapshot.js";
import { isConversationSource } from "../context/conversation-source-registry.js";

export const guardedContextLimits = { pageSize: 100, pages: 3, targetedPages: 5, replyDepth: 20, overflowDepth: 40, overflowChars: 12000, messageChars: 4000, replyChars: 6000, burstMessages: 16, burstChars: 6000, targetedMessages: 8,
  dependencies: 128, sourceReads: 4096, maxValidationPasses: 64 } as const;
export interface GuardedContextSource {
  sourceMessageId?: string | null;
  assets?: readonly GuardedAssetDescriptor[];
  event: ChannelHistoryMessage;
  origin: "human" | "chat" | "other";
  provenance: ContextProvenance | null;
}
export interface GuardedAssetDescriptor { id: string; contentType: string; size: number }
// Link-preview images ("embed-" ids) are left out: Discord hydrates them
// after the message is created, and they derive from the URL already in the
// hashed text. Pinning them would invalidate sources that merely unfurled.
export const guardedAssetsHash = (assets: readonly GuardedAssetDescriptor[]): string => hashContent(JSON.stringify(
  [...assets].filter((asset) => !asset.id.startsWith("embed-")).map(({ id, contentType, size }) => ({ id, contentType, size })).sort((a, b) => a.id.localeCompare(b.id))));
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
  // Checks messages a stored proof cites (a memory, or an earlier bot reply) against persistence
  // and settings only: forget tombstones and collection opt-outs. With it, those messages are never
  // fetched from Discord again; only the current conversation is. Without it, every cited message
  // is re-read and compared.
  sourcesAllowed?: (sources: readonly CitedSource[], signal: AbortSignal) => Promise<readonly boolean[]>;
  // Committed revocations (observed Discord deletes) for messages in this channel, by ID only, so it
  // covers bot-authored messages too. Consulted before any author rule; a failed check counts as revoked.
  revoked?: (messageIds: readonly string[], signal: AbortSignal) => Promise<readonly boolean[]>;
  // The provenance graph's per-kind admission gate. Used only together with sourcesAllowed, so the
  // messages a graph-admitted artifact reaches still pass the same forget and opt-out checks.
  graph?: GuardedGraphPort;
  policyCurrent(): boolean;
}
export interface CitedSource { messageId: string; authorId: string; timestampMs: number }
export interface GuardedGraphPort {
  mode(kind: ProvenanceReaderKind): ProvenanceReaderMode;
  decide(kind: ProvenanceReaderKind, candidates: readonly ProvenanceCandidate[], audienceUserId: string | null, signal: AbortSignal): Promise<readonly ProvenanceDecision[]>;
}
type ProofDependency = ContextProvenance["dependencies"][number];
const backgroundOnly = (dependency: ProofDependency): boolean => dependency.projection?.kind === "background_text";
// How many stored claims one memory pass inspects, in the order given.
export const maxClaimCandidates = 128;
const artifactKey = (artifactId: string, outputHash: string): string => JSON.stringify([artifactId, outputHash]);
const citedKey = (item: CitedSource): string => JSON.stringify([item.messageId, item.authorId, item.timestampMs]);
// Keeps each batched check well inside SQL parameter limits.
function chunk512<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += 512) chunks.push(items.slice(index, index + 512));
  return chunks;
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
    return [...this.evidence.values(), ...this.carried.values()].some((source) => source.timestampMs <= (cutoff(source.authorId) ?? -Infinity));
  }
  public get durableWritesAllowed(): boolean { return !this.closed && this.port.persist !== false && this.port.policyCurrent(); }
  public get sharedMemoryAllowed(): boolean { return this.durableWritesAllowed && this.port.shareMemory === true; }
  public get scope(): Readonly<{ guildId: string; channelId: string; actorId: string | null }> { return Object.freeze({ guildId: this.port.guildId, channelId: this.port.channelId, actorId: this.port.actorId }); }
  public get cancellationSignal(): AbortSignal | undefined { return this.port.turnSignal; }
  public get admittedActorIds(): readonly string[] { return Object.freeze([...new Set([...this.reactionActors.keys(), ...this.identityActors])]); }
  private reads = 0;
  private passes = 0;
  private closed = false;
  private cache = new Map<string, Promise<GuardedContextSource | null>>();
  // Revocation answers for this phase only. validate() always asks again.
  private revocations = new Map<string, boolean>();
  // This phase's answers from sourcesAllowed, keyed by cited message, author and time.
  private citedAnswers = new Map<string, boolean>();
  private signal = new AbortController().signal;
  private readonly evidence = new Map<string, ChannelHistoryMessage>();
  private readonly evidenceVersions = new Map<string, string>();
  private readonly evidenceAssets = new Map<string, readonly GuardedAssetDescriptor[]>();
  // Older messages a used proof cites, taken from the proof itself rather than fetched. They pass
  // into this turn's own provenance as they are. Only used when the port has sourcesAllowed.
  private readonly carried = new Map<string, ProofDependency>();
  // How each message reached this turn, for the provenance graph: read as an input of its own, or
  // brought in by an earlier artifact's proof ("reply:<id>", "claim:<id>", "derived:<purpose>").
  private readonly directIds = new Set<string>();
  private readonly carriers = new Map<string, Set<string>>();
  private readonly evidenceOrigins = new Map<string, "human" | "chat">();
  // Earlier replies admitted through the graph, with the messages they reach. Each is one direct input;
  // its ancestry stays in the graph instead of being carried into this turn's proof.
  private readonly graphReplies = new Map<string, { kind: ProvenanceReaderKind; messages: readonly CitedSource[] }>();
  private graphAncestry = false;
  // Earlier artifacts (claims, aliases, relations, character state) admitted through the graph and used,
  // keyed "<kind>:<artifact ID>". Each becomes a parent edge of what this turn builds.
  private readonly graphArtifacts = new Map<string, { kind: ProvenanceReaderKind; graphKind: ProvenanceArtifactKind; artifactId: string; outputHash: string; messages: readonly CitedSource[] }>();
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
  // Every message in this channel the turn has read as conversation so far. Anything that stores text
  // taken from this turn (a query, history, a model's tool arguments) records these as its lineage.
  // Includes the messages graph-admitted inputs reach, so a trace tied to this lineage goes with any of them.
  public get lineageMessageIds(): readonly string[] {
    return Object.freeze([...new Set([...this.revocableIds(), ...[...this.graphReplies].filter(([id]) => this.evidence.has(id)).flatMap(([, entry]) => entry.messages.map((message) => message.messageId)),
      ...[...this.graphArtifacts.values()].flatMap((entry) => entry.messages.map((message) => message.messageId))])]);
  }
  public get burst(): ChannelHistoryMessage[] { return immutableSnapshot(this.sourceBurst); }
  public get currentEvent(): ConversationEvent | undefined { return this.sourceEvent ? immutableSnapshot(this.sourceEvent) : undefined; }
  public get report(): GuardedContextReport { return immutableSnapshot(this.coverageReport); }

  private phase<T>(operation: () => Promise<T>, phase: GuardedContextPhase = "assembly"): Promise<T> {
    const work = this.phaseQueue.then(() => this.runPhase(operation, phase));
    this.phaseQueue = work.then(() => undefined, () => undefined); return work;
  }
  // Phases have no budget of their own. Only the turn deadline (turnSignal)
  // cancels in-flight work, so slow rate-limited reads delay a turn rather
  // than suppressing it.
  private async runPhase<T>(operation: () => Promise<T>, phase: GuardedContextPhase): Promise<T> {
    const turn = this.port.turnSignal;
    if (this.closed || !this.port.policyCurrent() || turn?.aborted) throw new SocialOutputSuppressed();
    const controller = new AbortController(); this.signal = controller.signal;
    if (!this.port.snapshotCurrent) this.cache = new Map();
    this.revocations = new Map(); this.citedAnswers = new Map();
    const started = Date.now(); let cancel: (() => void) | undefined;
    let status: "completed" | "deadline" | "failed" = "failed";
    try {
      const result = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        cancel = (): void => { status = "deadline"; this.closed = true; controller.abort(); this.coverageReport.status = "deadline"; reject(new SocialOutputSuppressed()); };
        turn?.addEventListener("abort", cancel, { once: true });
      })]);
      status = "completed"; return result;
    } finally {
      if (cancel) turn?.removeEventListener("abort", cancel);
      this.port.work?.(phase, status, Date.now() - started);
    }
  }

  // The revocation check sits outside the source cache, so a warm snapshot cannot return a deleted message.
  private async read(id: string, path = new Set<string>()): Promise<GuardedContextSource | null> {
    const source = await this.readSource(id, path);
    return source && !await this.anyRevoked([id]) ? source : null;
  }

  private async readSource(id: string, path: Set<string>): Promise<GuardedContextSource | null> {
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
        const graph = this.port.graph && this.port.sourcesAllowed ? this.port.graph : null;
        const mode = graph?.mode("reply_part") ?? "v1";
        // A reply built on graph ancestry has a v1 proof that is not complete on its own; only v2 reads it.
        const preAdmitted = this.graphReplies.has(id);
        if (!proof || proof.purpose && proof.purpose !== "reply" || proof.coverage !== "complete" && !((mode === "v2" || preAdmitted) && graphAncestryOnly(proof))) { this.coverageReport.unverifiedBot++; return null; }
        if (proof.outputHash !== hashContent(source.event.content)) { this.coverageReport.invalidatedDerived++; return null; }
        if (proof.outputAssetsHash && proof.outputAssetsHash !== guardedAssetsHash(source.assets ?? [])) return null;
        if (!this.port.sourcesAllowed) await this.port.prepareValidation?.(proof.dependencies.filter((dependency) => dependency.guildId === this.port.guildId && dependency.channelId === this.port.channelId).map((dependency) => dependency.messageId), this.signal).catch(() => undefined);
        if (preAdmitted) return source;
        const v1 = proof.coverage === "complete" && await this.proofSourcesCurrent(proof, next);
        if (graph && mode !== "v1") {
          const [decision] = await graph.decide("reply_part", [{ graphKind: "reply_part", artifactId: id, v1 }], this.port.audienceUserId ?? null, this.signal);
          if (decision?.source === "graph") {
            // The graph decided: the messages it reaches still face v1's forget and opt-out checks.
            if (!decision.admitted || !await this.citedAllowed(decision.messages)) { this.coverageReport.invalidatedDerived++; return null; }
            this.graphReplies.set(id, { kind: "reply_part", messages: decision.messages });
            return source;
          }
          if (!decision?.admitted) { this.coverageReport.invalidatedDerived++; return null; }
        } else if (!v1) { this.coverageReport.invalidatedDerived++; return null; }
      }
      return source;
    })();
    this.cache.set(id, pending); return pending;
  }

  // carriers: the earlier artifacts whose proofs supply this message; none when it is an input itself.
  private async retain(id: string, carriers: readonly string[] = []): Promise<ChannelHistoryMessage | null> {
    const source = await this.read(id); if (!source) { this.coverageReport.omitted++; return null; }
    const add = async (item: GuardedContextSource, via: readonly string[]): Promise<boolean> => {
      this.evidenceOrigins.set(item.event.messageId, item.origin === "chat" ? "chat" : "human");
      if (via.length) for (const carrier of via) this.addCarrier(item.event.messageId, carrier); else this.directIds.add(item.event.messageId);
      if (this.evidence.has(item.event.messageId)) {
        if (this.evidenceVersions.get(item.event.messageId) !== sourceVersion(item)) throw new SocialOutputSuppressed();
        this.evidenceAssets.set(item.event.messageId, immutableSnapshot(item.assets ?? []));
        return true;
      }
      // Carried citations share the proof's dependency limit, so a message already carried costs nothing more.
      if (!this.carried.has(item.event.messageId) && this.dependencyCount() >= guardedContextLimits.dependencies) return false;
      this.evidence.set(item.event.messageId, item.event);
      this.evidenceVersions.set(item.event.messageId, sourceVersion(item));
      this.evidenceAssets.set(item.event.messageId, immutableSnapshot(item.assets ?? []));
      if (item.origin === "chat" && this.graphReplies.has(item.event.messageId)) this.graphAncestry = true;
      else if (item.origin === "chat" && this.port.sourcesAllowed) { if (!this.carry(item.provenance!.dependencies, `reply:${item.event.messageId}`)) return false; }
      else if (item.origin === "chat") for (const dependency of item.provenance!.dependencies) {
        const original = await this.read(dependency.messageId); if (!original || !await add(original, [`reply:${item.event.messageId}`])) return false;
        if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
      }
      if (item.provenance && !await this.retainActors(item.provenance)) return false;
      for (const entry of item.provenance?.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
      return true;
    };
    const before = new Set(this.evidence.keys());
    if (!await add(source, carriers)) {
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
      lease.coverageReport.truncated += bounded.truncated;
      // The window comes first: people's messages, newest first. Earlier bot replies come second and
      // only take the proof space left for their citations; one whose citations do not fit is left out.
      const newestFirst = [...bounded.messages].reverse(); const admitted = new Set<string>();
      for (const pass of ["people", "bot_replies"] as const) for (const event of newestFirst) {
        if (admitted.has(event.messageId)) continue;
        if (((await lease.read(event.messageId))?.origin === "chat") !== (pass === "bot_replies")) continue;
        if (await lease.retain(event.messageId)) admitted.add(event.messageId);
      }
      lease.sourceHistory = bounded.messages.filter((event) => admitted.has(event.messageId));
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
      const graphMode = this.port.graph && this.port.sourcesAllowed ? this.port.graph.mode("session") : "v1";
      const candidates = exchanges.slice(-4).flatMap((exchange) => {
        const proof = parseScopedContextProvenance(exchange.contextProvenance, { guildId: this.port.guildId, channelId: this.port.channelId, userId: actorId });
        const sourceId = exchange.user.sourceMessageId; const deliveryIds = exchange.assistant.messageIds;
        if (proof ? proof.purpose && proof.purpose !== "reply" || proof.coverage !== "complete" && !(graphMode === "v2" && graphAncestryOnly(proof)) ||
            proof.outputHash !== hashContent(exchange.assistant.content)
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
        // v1 checks the proof's flattened sources. Once the graph decides, the delivered parts carry the
        // exchange's ancestry instead: each part is one input, checked through its own graph revision.
        const v1 = proof ? proof.coverage === "complete" && await this.proofSourcesCurrent(proof) : true;
        const route = proof && graphMode !== "v1" ? await this.admitThroughGraph("session", deliveryIds, v1) : "v1";
        if (route === "rejected") continue;
        let valid = route === "graph" || v1;
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
        const deliveryCarriers = deliveryIds.map((id) => `reply:${id}`);
        if (route === "v1") for (const id of proof?.dependencies.map((source) => source.messageId) ?? []) if (!await this.retain(id, deliveryCarriers)) valid = false;
        for (const id of [...deliveryIds, sourceId]) if (!await this.retain(id)) valid = false;
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

  // Distinct messages the reply's proof will list: evidence plus carried citations not also read as evidence.
  private dependencyCount(): number {
    let count = this.evidence.size;
    for (const id of this.carried.keys()) if (!this.evidence.has(id)) count++;
    return count;
  }
  private addCarrier(messageId: string, carrier: string): void {
    const known = this.carriers.get(messageId);
    if (known) known.add(carrier); else this.carriers.set(messageId, new Set([carrier]));
  }
  // Adds the messages a used proof cites, all or none, without fetching them. carrier names that proof.
  private carry(dependencies: readonly ProofDependency[], carrier: string): boolean {
    const added = dependencies.filter((dependency) => !this.evidence.has(dependency.messageId) && !this.carried.has(dependency.messageId));
    if (this.dependencyCount() + new Set(added.map((dependency) => dependency.messageId)).size > guardedContextLimits.dependencies) return false;
    for (const dependency of added) this.carried.set(dependency.messageId, dependency);
    for (const dependency of dependencies) this.addCarrier(dependency.messageId, carrier);
    // A message carried only as summary text and now also used as conversation keeps the conversational
    // entry, so a Discord delete still reaches this turn and everything derived from it.
    for (const dependency of dependencies) {
      const prior = this.carried.get(dependency.messageId);
      if (prior && backgroundOnly(prior) && !backgroundOnly(dependency)) this.carried.set(dependency.messageId, dependency);
    }
    return true;
  }
  // Whether any of these messages has a committed revocation. fresh skips this phase's answers.
  private async anyRevoked(ids: readonly string[], fresh = false): Promise<boolean> {
    if (!this.port.revoked) return false;
    const unique = [...new Set(ids)];
    if (!fresh && unique.some((id) => this.revocations.get(id) === true)) return true;
    const pending = fresh ? unique : unique.filter((id) => !this.revocations.has(id));
    if (!pending.length) return false;
    const answers = await this.port.revoked(pending, this.signal).catch(() => null);
    if (!answers || answers.length !== pending.length || answers.some((answer) => typeof answer !== "boolean")) return true;
    pending.forEach((id, index) => this.revocations.set(id, answers[index]!));
    return answers.some(Boolean);
  }
  // Answers revocations and cited-source checks for many claims at once, so the per-claim checks that
  // follow read this phase's memo instead of one round trip each. A failed batch leaves nothing in the
  // memo, and the per-claim checks then ask again and fail closed on their own.
  private async primeSourceChecks(proofs: readonly ContextProvenance[]): Promise<void> {
    const dependencies = proofs.flatMap((proof) => proof.dependencies)
      .filter((dependency) => dependency.guildId === this.port.guildId && dependency.channelId === this.port.channelId);
    if (this.port.revoked) {
      const pending = [...new Set(dependencies.filter((dependency) => !backgroundOnly(dependency)).map((dependency) => dependency.messageId))]
        .filter((id) => !this.revocations.has(id));
      for (const chunk of chunk512(pending)) {
        const answers = await this.port.revoked(chunk, this.signal).catch(() => null);
        if (!answers || answers.length !== chunk.length || answers.some((answer) => typeof answer !== "boolean")) break;
        chunk.forEach((id, index) => this.revocations.set(id, answers[index]!));
      }
    }
    if (this.port.sourcesAllowed) {
      const pending = [...new Map(dependencies.map(({ messageId, authorId, timestampMs }) => [citedKey({ messageId, authorId, timestampMs }), { messageId, authorId, timestampMs }])).entries()]
        .filter(([key]) => !this.citedAnswers.has(key));
      for (const chunk of chunk512(pending)) {
        const answers = await this.port.sourcesAllowed(chunk.map(([, cited]) => cited), this.signal).catch(() => null);
        if (!answers || answers.length !== chunk.length) break;
        chunk.forEach(([key], index) => this.citedAnswers.set(key, answers[index] === true));
      }
    }
  }
  // Whether every cited message passes forget tombstones and opt-outs, asking only for what this phase
  // has not answered yet.
  private async citedAllowed(cited: readonly CitedSource[]): Promise<boolean> {
    const pending = [...new Map(cited.map((item) => [citedKey(item), item])).entries()].filter(([key]) => !this.citedAnswers.has(key));
    if (pending.length) {
      const answers = await this.port.sourcesAllowed!(pending.map(([, item]) => item), this.signal);
      if (answers.length !== pending.length) return false;
      pending.forEach(([key], index) => this.citedAnswers.set(key, answers[index] === true));
    }
    return cited.every((item) => this.citedAnswers.get(citedKey(item)) === true);
  }
  // One batched graph decision per reader kind, keyed by artifactKey: two versions of one artifact are
  // separate candidates, and only the one the graph holds as current can be admitted.
  private async decideArtifacts(kind: ProvenanceReaderKind, graphKind: ProvenanceArtifactKind, items: readonly { artifactId: string; outputHash: string; v1: boolean }[]):
    Promise<ReadonlyMap<string, ProvenanceDecision>> {
    const decided = new Map<string, ProvenanceDecision>();
    if (!this.port.graph || !items.length) return decided;
    const unique = [...new Map(items.map((item) => [artifactKey(item.artifactId, item.outputHash), item])).values()];
    const decisions = await this.port.graph.decide(kind, unique.map((item) => ({ graphKind, ...item })), this.port.audienceUserId ?? null, this.signal)
      .catch(() => unique.map((): ProvenanceDecision => ({ admitted: false, source: "graph", messages: [] })));
    unique.forEach((item, index) => decided.set(artifactKey(item.artifactId, item.outputHash), decisions[index] ?? { admitted: false, source: "graph", messages: [] }));
    return decided;
  }
  private useGraphArtifact(kind: ProvenanceReaderKind, graphKind: ProvenanceArtifactKind, artifactId: string, outputHash: string, messages: readonly CitedSource[]): void {
    this.graphArtifacts.set(`${graphKind}:${artifactId}`, { kind, graphKind, artifactId, outputHash, messages });
    this.graphAncestry = true;
  }
  // Delivered replies admitted together through the graph for one reader kind. "graph": every reply is
  // in the graph and admitted, and the messages they reach pass forget and opt-out. "v1": some reply has
  // no graph revision (or the kind is in shadow), so the caller keeps its v1 path. "rejected": the graph
  // refused one of them.
  private async admitThroughGraph(kind: ProvenanceReaderKind, ids: readonly string[], v1: boolean): Promise<"graph" | "v1" | "rejected"> {
    if (!this.port.graph || !this.port.sourcesAllowed || !ids.length) return "v1";
    const decisions = await this.port.graph.decide(kind, ids.map((artifactId) => ({ graphKind: "reply_part" as const, artifactId, v1 })),
      this.port.audienceUserId ?? null, this.signal).catch(() => null);
    if (!decisions || decisions.length !== ids.length) return "rejected";
    if (decisions.some((decision) => decision.source === "v1")) return "v1";
    if (decisions.some((decision) => !decision.admitted) || !await this.citedAllowed(decisions.flatMap((decision) => decision.messages))) return "rejected";
    ids.forEach((id, index) => { if (!this.graphReplies.has(id)) this.graphReplies.set(id, { kind, messages: decisions[index]!.messages }); });
    return "graph";
  }
  // Graph-admitted replies are checked again on every use: a revocation committed since reaches them
  // through the graph. At an effect, the messages they reach face the forget and opt-out checks afresh.
  private async graphRepliesCurrent(effect: boolean): Promise<boolean> {
    const used: { kind: ProvenanceReaderKind; candidate: ProvenanceCandidate }[] = [...this.graphReplies].filter(([id]) => this.evidence.has(id))
      .map(([artifactId, entry]) => ({ kind: entry.kind, candidate: { graphKind: "reply_part", artifactId, v1: false } }));
    for (const entry of this.graphArtifacts.values()) used.push({ kind: entry.kind, candidate: { graphKind: entry.graphKind, artifactId: entry.artifactId, v1: false, outputHash: entry.outputHash } });
    if (!used.length || !this.port.graph) return true;
    const decisions: ProvenanceDecision[] = [];
    for (const kind of new Set(used.map((entry) => entry.kind))) {
      const candidates = used.filter((entry) => entry.kind === kind).map((entry) => entry.candidate);
      const decided = await this.port.graph.decide(kind, candidates, this.port.audienceUserId ?? null, this.signal).catch(() => null);
      if (!decided || decided.length !== candidates.length) return false;
      decisions.push(...decided);
    }
    if (decisions.some((decision) => decision.source !== "graph" || !decision.admitted)) return false;
    if (!effect || !this.port.sourcesAllowed) return true;
    const messages = [...new Map(decisions.flatMap((decision) => decision.messages).map((message) => [message.messageId, message])).values()];
    if (!messages.length) return true;
    const allowed = await this.port.sourcesAllowed(messages, this.signal);
    return allowed.length === messages.length && allowed.every(Boolean);
  }
  // Messages this turn depends on as conversation. Data built only from daily-summary or history-scan
  // text keeps the guild's existing retention policy and is not revoked by an observed delete.
  private revocableIds(): string[] {
    return [...this.evidence.keys(), ...[...this.carried.values()].filter((dependency) => !this.evidence.has(dependency.messageId) && !backgroundOnly(dependency)).map((dependency) => dependency.messageId)];
  }
  private async carriedAllowed(): Promise<boolean> {
    const carried = [...this.carried.values()].filter((dependency) => !this.evidence.has(dependency.messageId));
    if (!carried.length || !this.port.sourcesAllowed) return true;
    const allowed = await this.port.sourcesAllowed(carried.map(({ messageId, authorId, timestampMs }) => ({ messageId, authorId, timestampMs })), this.signal);
    return allowed.length === carried.length && allowed.every(Boolean);
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

  // Recall's eligibility pass, ahead of ranking. Same access, actor and proof checks and the same
  // per-statement limit, but no count or character budget and nothing retained: those apply later,
  // through memories(selected, true), to the ranked selection alone.
  public async recallEligible(records: readonly Memory[], now = Date.now()): Promise<Memory[]> {
    return this.claims(records, false, now, false, false, false);
  }

  private async claims(records: readonly Memory[], retain: boolean, now: number, character: boolean, classification = false, budget = true): Promise<Memory[]> {
    return this.phase(async () => {
      const allowed: Memory[] = []; let chars = 0;
      // Claim proofs usually depend on messages older than the history window.
      // Page them in together instead of one rate-limited fetch per message.
      const dependencyIds = records.slice(0, maxClaimCandidates).flatMap((record) => memoryClaimProof(record.contextProvenance, record)?.dependencies
        .filter((dependency) => dependency.guildId === this.port.guildId && dependency.channelId === this.port.channelId)
        .map((dependency) => dependency.messageId) ?? []);
      if (dependencyIds.length && !this.port.sourcesAllowed) await this.port.prepareValidation?.([...new Set(dependencyIds)], this.signal).catch(() => undefined);
      await this.primeSourceChecks(records.slice(0, maxClaimCandidates).flatMap((record) => memoryClaimProof(record.contextProvenance, record) ?? []));
      const graphMode = this.port.graph && this.port.sourcesAllowed ? this.port.graph.mode("claim") : "v1";
      const accept = graphMode === "v2" ? "graph" : "complete";
      const decisions = graphMode === "v1" ? null : await this.decideArtifacts("claim", "claim", await Promise.all(records.slice(0, maxClaimCandidates).flatMap((record) => {
        const proof = memoryClaimProof(record.contextProvenance, record, accept);
        return proof ? [(async (): Promise<{ artifactId: string; outputHash: string; v1: boolean }> => ({ artifactId: record.id, outputHash: proof.outputHash, v1: proof.coverage === "complete" && await this.proofSourcesCurrent(proof) }))()] : [];
      })));
      for (const record of records.slice(0, maxClaimCandidates)) {
        if (budget && allowed.length === 20) break;
        if (record.statement.length > 1000 || budget && chars + record.statement.length > 3000) continue;
        const proof = memoryClaimProof(record.contextProvenance, record, accept);
        if (!proof || proof.audience.guildId !== this.port.guildId || proof.audience.channelId !== this.port.channelId ||
            proof.audience.userId !== null && proof.audience.userId !== this.port.actorId ||
            record.audience === "private" && (this.port.audienceUserId !== record.ownerUserId || this.port.actorId !== record.ownerUserId) ||
            (character ? !record.moduleId || !canRecall(record, { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.actorId ?? "" }, now)
              : !canRecallOrdinaryMemory(classification && record.status === "candidate" ? { ...record, status: "active" } : record,
                { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.actorId ?? "" }, now))) continue;
        const subject = record.subjectType === "member" ? await this.port.actor(record.subjectId, this.signal) : null;
        if (record.subjectType === "member" && !subject) continue;
        // The graph decides a migrated claim; its sources still face forget and opt-out. Otherwise v1 decides.
        const decision = decisions?.get(artifactKey(record.id, proof.outputHash));
        const viaGraph = decision?.source === "graph";
        if (viaGraph && (!decision.admitted || !await this.citedAllowed(decision.messages))) continue;
        let valid = viaGraph || (decision ? decision.admitted : await this.proofSourcesCurrent(proof));
        if (!valid) continue;
        if (retain) {
          if (!await this.retainActors(proof)) continue;
          for (const entry of proof.resources ?? []) this.resources.set(`${entry.kind}:${entry.id}`, entry);
          if (viaGraph) this.useGraphArtifact("claim", "claim", record.id, proof.outputHash, decision.messages);
          else if (this.port.sourcesAllowed) { if (!this.carry(proof.dependencies, `claim:${record.id}`)) continue; }
          else {
            const before = new Set(this.evidence.keys());
            for (const dependency of proof.dependencies) if (!await this.retain(dependency.messageId, [`claim:${record.id}`])) valid = false;
            if (!valid) { for (const id of this.evidence.keys()) if (!before.has(id)) { this.evidence.delete(id); this.evidenceVersions.delete(id); this.evidenceAssets.delete(id); } continue; }
            for (const dependency of proof.dependencies) if (dependency.assetsHash) this.assetDependencies.set(dependency.messageId, dependency.assetsHash);
          }
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
    if (proof.dependencies.some((dependency) => dependency.guildId !== this.port.guildId || dependency.channelId !== this.port.channelId)) return false;
    if (await this.anyRevoked(proof.dependencies.filter((dependency) => !backgroundOnly(dependency)).map((dependency) => dependency.messageId))) return false;
    if (this.port.sourcesAllowed) {
      // Cited messages are checked against forget tombstones and opt-outs, never fetched again.
      return this.citedAllowed(proof.dependencies.map(({ messageId, authorId, timestampMs }) => ({ messageId, authorId, timestampMs })));
    }
    for (const dependency of proof.dependencies) {
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
      if (this.port.sourcesAllowed) { if (!this.carry(proof.dependencies, `derived:${purpose}`)) return false; }
      else for (const entry of proof.dependencies) {
        if (!await this.retain(entry.messageId, [`derived:${purpose}`])) return false;
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
      // Every provider attempt and effect validates, so a revocation committed after collection stops
      // the next one even when the snapshot below answers from its cache.
      if (await this.anyRevoked(this.revocableIds(), true)) return false;
      if (!await this.graphRepliesCurrent(freshness === "effect")) return false;
      if (this.port.snapshotCurrent) return await this.port.snapshotCurrent(freshness === "effect", this.signal, [...this.evidence.keys()]) &&
        (freshness !== "effect" || await this.carriedAllowed()) &&
        await this.validateResources({ resources: [...this.resources.values()] }) && this.port.policyCurrent();
      if (!await this.carriedAllowed()) return false;
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

  // How each message this turn's proof lists reached it, for the provenance graph.
  public graphInputs(): ProvenanceInput[] {
    return [...[...new Set([...this.evidence.keys(), ...this.carried.keys()])].map((messageId) => ({ messageId, origin: this.evidenceOrigins.get(messageId) ?? null,
      direct: this.directIds.has(messageId), carriers: [...(this.carriers.get(messageId) ?? [])] })),
      ...[...this.graphArtifacts].map(([key, entry]) => ({ messageId: `artifact:${key}`, origin: null, direct: true, carriers: [],
        artifact: { kind: entry.graphKind, artifactId: entry.artifactId, outputHash: entry.outputHash } }))];
  }

  public provenance(output: string, purpose: "reply" | "memory_claim" | "character_state" | "relation" | "identity_alias" = "reply"): ContextProvenance | null {
    return this.buildProvenance(output, purpose, false);
  }
  public sessionProvenance(output: string): ContextProvenance | null {
    return this.port.retention === "session" ? this.buildProvenance(output, "reply", true) : null;
  }
  private buildProvenance(output: string, purpose: "reply" | "memory_claim" | "character_state" | "relation" | "identity_alias", session: boolean): ContextProvenance | null {
    const carried = [...this.carried.values()].filter((dependency) => !this.evidence.has(dependency.messageId));
    if (this.port.persist === false && !session || this.closed || !this.port.policyCurrent() || !this.evidence.size || this.evidence.size + carried.length > contextProvenanceLimits.dependencies) return null;
    // With graph ancestry the listed dependencies are not complete on their own: a v1 reader rejects it.
    return parseContextProvenance({ version: 1, ...(purpose !== "reply" ? { purpose } : {}), coverage: this.graphAncestry ? "partial" : "complete", audience: { guildId: this.port.guildId, channelId: this.port.channelId, userId: this.port.audienceUserId ?? null },
      outputHash: hashContent(output), dependencies: [...[...this.evidence.values()].map((source) => ({ guildId: this.port.guildId,
        channelId: this.port.channelId, messageId: source.messageId, authorId: source.authorId, timestampMs: source.timestampMs,
        representationHash: contextSourceHash(source), ...(this.assetDependencies.has(source.messageId) ? { assetsHash: this.assetDependencies.get(source.messageId) } : {}) })), ...carried], actors: [
          ...[...this.reactionActors.values()].map((actor) => ({ userId: actor.id, representationHash: actorSourceHash(actor) })),
          ...[...this.identityActors].filter((id) => !this.reactionActors.has(id)).map((id) => ({ userId: id, projection: "identity" as const, representationHash: hashContent(JSON.stringify({ id })) })),
        ],
      ...(this.publicTools.size ? { publicTools: [...this.publicTools.values()] } : {}),
      ...(this.resources.size ? { resources: [...this.resources.values()] } : {}),
      ...(this.publicWebUsed ? { publicWeb: { citationHashes: [...this.publicWebCitations].sort() } } : {}), unresolved: this.graphAncestry ? ["graph_ancestry"] : [] });
  }
}

// Same grounding anchors, independently bounded decision projection.
export function projectDecisionContext(request: ChatRequest, count: number): ChannelHistoryMessage[] {
  const anchors = [...request.replyChain]; const ids = new Set(anchors.map((event) => event.messageId));
  const slots = Math.max(0, count - anchors.length);
  const recent = slots ? request.channelHistory.filter((event) => !ids.has(event.messageId)).slice(-slots) : [];
  return [...anchors, ...recent].slice(-Math.max(count, anchors.length));
}
