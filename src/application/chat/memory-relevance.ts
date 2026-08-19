// Lightweight lexical/heuristic relevance scoring shared by the user-memory
// and guild-knowledge selectors. There's no embedding/vector-search
// infrastructure in this codebase, so this trades perfect semantic ranking
// for a cheap, dependency-free heuristic: keyword overlap with the current
// turn, a boost for records about someone actually present in the
// conversation, and a recency tie-breaker so unrelated records still sort
// sensibly instead of in arbitrary/insertion order.

const wordPattern = /[a-z0-9]{3,}/g;

export function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().match(wordPattern) ?? []);
}

export interface RelevanceContext {
  keywords: ReadonlySet<string>;
  subjectIds: ReadonlySet<string>;
  now: number;
}

export function buildRelevanceContext(input: {
  message: string;
  recentHistory: readonly { content: string }[];
  subjectIds: ReadonlySet<string>;
  now: number;
}): RelevanceContext {
  const keywords = new Set<string>(tokenize(input.message));
  for (const item of input.recentHistory) {
    for (const word of tokenize(item.content)) keywords.add(word);
  }
  return { keywords, subjectIds: input.subjectIds, now: input.now };
}

export interface ScorableRecord {
  subjectId: string;
  topic: string;
  slot: string;
  statement: string;
  updatedAt: number;
}

const subjectBoost = 3;
const maxRecencyBoost = 2;
const recencyHalfLifeMs = 30 * 24 * 60 * 60 * 1_000;

export function scoreRecord(context: RelevanceContext, record: ScorableRecord): number {
  let score = 0;
  for (const word of tokenize(`${record.topic} ${record.slot} ${record.statement}`)) {
    if (context.keywords.has(word)) score += 1;
  }
  if (context.subjectIds.has(record.subjectId)) score += subjectBoost;
  const ageMs = Math.max(0, context.now - record.updatedAt);
  score += maxRecencyBoost * Math.max(0, 1 - ageMs / recencyHalfLifeMs);
  return score;
}

export function selectByRelevance<T>(
  records: readonly T[],
  score: (record: T) => number,
  maxSerializedChars: number,
  // What actually gets serialized for the char-budget calculation — defaults
  // to the record itself. Callers whose record type carries fields never
  // sent to the model (e.g. GuildKnowledgeRecord.embedding) must pass a
  // projection that excludes them, or the budget check would be dominated
  // by a field the prompt never sees.
  promptProjection: (record: T) => unknown = (record) => record,
): T[] {
  const ranked = [...records].sort((a, b) => score(b) - score(a));
  const selected: T[] = [];
  let serializedChars = 0;
  for (const record of ranked) {
    const size = JSON.stringify(promptProjection(record)).length;
    if (selected.length > 0 && serializedChars + size > maxSerializedChars) break;
    selected.push(record);
    serializedChars += size;
  }
  return selected;
}

// Standard cosine similarity, clamped to [0, 1] since embedding relevance
// should only ever add to a lexical/subject/recency score, never subtract
// (a negative-cosine pair isn't "anti-relevant" for this use case). Returns
// 0 for a zero-length vector or a dimension mismatch rather than throwing —
// callers pass this straight into a scoring function that must never fail.
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, similarity));
}
