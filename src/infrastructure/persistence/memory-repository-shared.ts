import type {
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
