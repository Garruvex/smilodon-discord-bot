// Lexical/heuristic relevance scoring shared by the user-memory and
// guild-knowledge selectors. Lexical relevance uses BM25 (rare/discriminating
// terms score higher, longer statements are length-normalized so they don't
// win just by being wordy) rather than flat keyword-overlap counting, plus a
// boost for records about someone actually present in the conversation and a
// recency tie-breaker. When an embedding signal is also available, the two
// rankings (BM25 order, cosine-similarity order) are combined via Reciprocal
// Rank Fusion rather than a linear blend of incompatible scales — see
// reciprocalRankFusion below. Both are cheap, deterministic, and require no
// LLM call or external service.

// Matches only space-delimited ASCII/number words — kept exactly as it was
// before CJK support below was added, so English (and any other
// whitespace-delimited language) tokenizes identically to before.
const wordPattern = /[a-z0-9]{3,}/g;

// Han, Hiragana, Katakana, Hangul — scripts with no whitespace between
// words, where wordPattern above matches nothing at all. Segmented
// separately (not folded into wordPattern) because word boundaries here
// need dictionary-based segmentation, not a regex.
const cjkRunPattern = /[㐀-鿿぀-ヿ가-힣]+/g;

// Locale 'zh' gives Chinese-tailored dictionary segmentation. Japanese
// Kana/Hangul runs still get segmented (Intl.Segmenter doesn't require a
// per-script locale match to produce boundaries), just with lower accuracy
// than a ja/ko-tailored segmenter would give — acceptable since Chinese is
// this codebase's primary target script.
const cjkSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

// Common Chinese function words/particles — the equivalent of English
// stopwords like "the"/"is"/"a". Without filtering these, every Chinese
// statement would share near-identical high-frequency "terms" the way
// unfiltered English text would share "the" and "a", drowning out real
// signal. Not exhaustive — covers the highest-frequency offenders.
const cjkStopwords = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "們", "和", "與",
  "也", "就", "都", "而", "及", "或", "這", "那", "這個", "那個", "啊",
  "呢", "吧", "嗎", "喔", "欸", "哦", "很", "還", "又", "才", "把", "被",
  "但", "因為", "所以", "如果", "然後", "就是", "什麼", "怎麼", "一個",
]);

function cjkTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.match(cjkRunPattern) ?? []) {
    for (const segment of cjkSegmenter.segment(run)) {
      if (!segment.isWordLike || cjkStopwords.has(segment.segment)) continue;
      tokens.push(segment.segment);
    }
  }
  return tokens;
}

export function tokenize(text: string): ReadonlySet<string> {
  const asciiWords = text.toLowerCase().match(wordPattern) ?? [];
  return new Set([...asciiWords, ...cjkTokens(text)]);
}

// Same tokenization as `tokenize`, but preserving per-term occurrence counts
// — BM25's term-frequency component needs counts, not just membership.
function tokenizeWithCounts(text: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(wordPattern) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const word of cjkTokens(text)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
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

function recordText(record: ScorableRecord): string {
  return `${record.topic} ${record.slot} ${record.statement}`;
}

// BM25 corpus statistics (inverse document frequency per term, average
// document length) computed once over the current candidate record set —
// not global/persisted, since relevance is always scored against whatever
// records are eligible for this turn.
export interface Bm25Corpus {
  idf(term: string): number;
  avgDocLength: number;
}

export function buildBm25Corpus(records: readonly ScorableRecord[]): Bm25Corpus {
  const documentCount = records.length;
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const record of records) {
    const terms = tokenizeWithCounts(recordText(record));
    totalLength += terms.size;
    for (const term of terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return {
    avgDocLength: documentCount > 0 ? totalLength / documentCount : 0,
    idf: (term): number => {
      const df = documentFrequency.get(term) ?? 0;
      return Math.log((documentCount - df + 0.5) / (df + 0.5) + 1);
    },
  };
}

const bm25K1 = 1.2;
const bm25B = 0.75;

// BM25 lexical score against the query keywords in `context`, plus the same
// subject/recency adjustments the old flat scorer used — those aren't
// lexical-overlap concerns, so they stay additive on top rather than folded
// into the BM25 term.
export function bm25Score(corpus: Bm25Corpus, context: RelevanceContext, record: ScorableRecord): number {
  const termCounts = tokenizeWithCounts(recordText(record));
  const docLength = [...termCounts.values()].reduce((sum, count) => sum + count, 0);
  let score = 0;
  for (const keyword of context.keywords) {
    const termFrequency = termCounts.get(keyword) ?? 0;
    if (termFrequency === 0) continue;
    const idf = corpus.idf(keyword);
    const normalizedTermFrequency = (termFrequency * (bm25K1 + 1)) /
      (termFrequency + bm25K1 * (1 - bm25B + bm25B * (docLength / (corpus.avgDocLength || 1))));
    score += idf * normalizedTermFrequency;
  }
  if (context.subjectIds.has(record.subjectId)) score += subjectBoost;
  const ageMs = Math.max(0, context.now - record.updatedAt);
  score += maxRecencyBoost * Math.max(0, 1 - ageMs / recencyHalfLifeMs);
  return score;
}

// Rank-based fusion of one or more independently-ranked lists over the same
// item set — sidesteps the incompatible-scale problem of adding e.g. a BM25
// score directly to a cosine similarity. `k = 60` is the standard RRF
// constant. Keyed by item identity (===), so callers must rank the same
// object references across every list passed in.
export function reciprocalRankFusion<T>(
  rankings: readonly (readonly T[])[],
  k = 60,
): Map<T, number> {
  const scores = new Map<T, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => {
      scores.set(item, (scores.get(item) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
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
    if (serializedChars + size > maxSerializedChars) continue;
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

// Default floor a cosine-similarity pair must clear to count as "this
// candidate is actually relevant" (as opposed to merely ranking candidates
// against each other, where similarity > 0 alone admits nearly everything —
// unrelated short passages routinely land above 0 purely from shared
// language/embedding-space geometry, not real semantic relation).
//
// UNCALIBRATED: this number has not been validated against production
// embeddings from any specific provider/model. Cosine-similarity
// distributions differ meaningfully by embedding model — a value that's
// conservative for one model's geometry may be too strict or too loose for
// another's. Callers that gate real decisions on this threshold (selectors
// below) accept it as a constructor parameter specifically so it can be
// overridden per deployment without a code change once real embeddings
// data is available to tune it; treat this exported constant as a
// starting-point default, not a validated value.
export const minRelevantCosineSimilarity = 0.15;
