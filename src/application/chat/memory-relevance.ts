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
): T[] {
  const ranked = [...records].sort((a, b) => score(b) - score(a));
  const selected: T[] = [];
  let serializedChars = 0;
  for (const record of ranked) {
    const size = JSON.stringify(record).length;
    if (selected.length > 0 && serializedChars + size > maxSerializedChars) break;
    selected.push(record);
    serializedChars += size;
  }
  return selected;
}
