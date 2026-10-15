import type {
  Memory,
  MemoryRelationKind,
  MemoryRelationPredicate,
  MemorySubjectType,
  RelatedSubject,
} from "../../application/memory/memory.js";

// Backend-independent pieces of the MemoryRepository implementations —
// shared by sqlite-memory-repository.ts and postgres-memory-repository.ts so
// the two stay behaviorally identical.

// Bounds the supersede-chain walk in forget() — a fact revised more times
// than this is implausible; the cap only guards against a malformed cycle.
export const maxSupersedeChainDepth = 100;

// How many same-identity candidates corroboration looks at — conflicting
// claims coexist as separate rows, but not realistically more than a few.
export const maxCandidatesPerIdentity = 20;

// Ordinary reinforcements must not reset callback delivery state. A changed
// event discards pending work; completed/uncertain delivery follows the
// canonical event to prevent a date correction from sending twice.
export function retainCallbackMetadata(previous: unknown, incoming: unknown, revised: boolean, updatedAt: number): unknown {
  if (!previous || typeof previous !== "object" || !("callback" in previous)) return incoming;
  const callback = previous.callback;
  if (!callback || typeof callback !== "object" || !("status" in callback)) return incoming;
  const value: Record<string, unknown> = { ...(incoming && typeof incoming === "object" ? incoming : {}) };
  delete value.callback;
  if (revised && callback.status !== "delivered" && callback.status !== "uncertain" && callback.status !== "sending") return Object.keys(value).length ? value : null;
  return { ...value, callback: { ...callback, ...(!revised ? { revision: updatedAt } : callback.status === "sending" ? { status: "uncertain" } : {}) } };
}

export function assertersOf(
  memoryId: string,
  sources: readonly { memoryId: string; assertedByUserId: string | null }[],
): string[] {
  return [...new Set(sources
    .filter((source) => source.memoryId === memoryId && source.assertedByUserId !== null)
    .map((source) => source.assertedByUserId!))];
}

// One BFS round, shared with the Postgres repository: records each subject
// reached through `rows` once per relation kind — at the first hop that
// kind reaches it, rows scanned in (createdAt, id) order so the result is
// deterministic — and returns the subjects to expand next. Keying by kind
// means an "association" edge scanned first can't hide a "consequence"
// edge to the same subject, or vice versa.
export function collectRelatedSubjects(
  rows: readonly {
    fromSubjectType: string; fromSubjectId: string; toSubjectType: string; toSubjectId: string;
    kind: string; predicate: string;
  }[],
  frontier: readonly string[],
  hop: number,
  querySubjects: ReadonlySet<string>,
  visited: Set<string>,
  results: Map<string, RelatedSubject>,
): string[] {
  const frontierSet = new Set(frontier);
  const nextFrontier: string[] = [];
  for (const row of rows) {
    const fromInFrontier = frontierSet.has(row.fromSubjectId);
    const otherSubjectId = fromInFrontier ? row.toSubjectId : row.fromSubjectId;
    if (querySubjects.has(otherSubjectId)) continue;
    const key = `${row.kind}:${otherSubjectId}`;
    if (!results.has(key)) {
      results.set(key, {
        subjectType: (fromInFrontier ? row.toSubjectType : row.fromSubjectType) as MemorySubjectType,
        subjectId: otherSubjectId,
        hopDistance: hop,
        kind: row.kind as MemoryRelationKind,
        predicate: row.predicate as MemoryRelationPredicate,
        viaSubjectId: fromInFrontier ? row.fromSubjectId : row.toSubjectId,
        viaSubjectType: (fromInFrontier ? row.fromSubjectType : row.toSubjectType) as MemorySubjectType,
        edgePointsToVia: !fromInFrontier,
      });
    }
    if (!visited.has(otherSubjectId)) {
      visited.add(otherSubjectId);
      nextFrontier.push(otherSubjectId);
    }
  }
  return nextFrontier;
}

// Bounded legacy writer fingerprint. No other expiry is reinterpreted.
export function hasLegacyRelationshipExpiry(memory: Memory): boolean {
  if (memory.moduleId !== "relationships" || memory.kind !== "impression" || memory.subjectType !== "member" ||
      memory.status !== "active" || memory.validUntil !== null || memory.source !== "consolidation" ||
      memory.topic !== "character.relationships" || !/^relationship\.[a-f0-9]{12}$/.test(memory.slot) || memory.expiresAt === null) return false;
  const days = (memory.expiresAt - memory.updatedAt) / 86_400_000;
  const metadata = memory.structuredValue as { relationshipVersion?: unknown; dependencies?: unknown } | null;
  return Number.isInteger(days) && days >= 1 && days <= 365 && !!metadata && metadata.relationshipVersion === undefined &&
    Array.isArray(metadata.dependencies) && metadata.dependencies.length > 0 && metadata.dependencies.every((dependency: unknown) => {
      if (!dependency || typeof dependency !== "object") return false;
      const value = dependency as Record<string, unknown>;
      return typeof value.id === "string" && value.subjectId === memory.subjectId && typeof value.updatedAt === "number" &&
        Array.isArray(value.sourceIds) && value.sourceIds.length > 0 && value.sourceIds.every((id: unknown) => typeof id === "string");
    });
}
