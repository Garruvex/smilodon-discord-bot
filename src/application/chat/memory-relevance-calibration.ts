import {
  bm25LexicalScore,
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  reciprocalRankFusion,
  type Bm25ScoreWeights,
  type ScorableRecord,
} from "./memory-relevance.js";

export interface RelevanceCalibrationCandidate extends ScorableRecord {
  id: string;
  // Captured from the production prompt projection when available, so a
  // compact exported record still consumes its true live prompt budget.
  serializedChars?: number | undefined;
  cosineSimilarity?: number | undefined;
  relationBoost?: number | undefined;
}

export interface RelevanceCalibrationCase {
  id: string;
  split: "calibration" | "validation";
  message: string;
  recentHistory?: readonly string[] | undefined;
  subjectIds: readonly string[];
  now: number;
  candidates: readonly RelevanceCalibrationCandidate[];
  relevantIds: readonly string[];
  maxResults?: number | undefined;
  maxSerializedChars?: number | undefined;
  requireTopicalMatch?: boolean | undefined;
}

export interface RetrievalMetrics {
  recall: number;
  precision: number;
  meanReciprocalRank: number;
  normalizedDiscountedCumulativeGain: number;
  objective: number;
}

export interface CalibrationResult {
  weights: Readonly<Bm25ScoreWeights>;
  calibration: RetrievalMetrics;
  validation: RetrievalMetrics | null;
}

const emptyMetrics: RetrievalMetrics = {
  recall: 0,
  precision: 0,
  meanReciprocalRank: 0,
  normalizedDiscountedCumulativeGain: 0,
  objective: 0,
};

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function evaluateBm25Weights(
  cases: readonly RelevanceCalibrationCase[],
  weights: Readonly<Bm25ScoreWeights>,
): RetrievalMetrics {
  if (cases.length === 0) return emptyMetrics;

  const recalls: number[] = [];
  const precisions: number[] = [];
  const reciprocalRanks: number[] = [];
  const normalizedGains: number[] = [];

  for (const evaluationCase of cases) {
    const corpus = buildBm25Corpus(evaluationCase.candidates);
    const context = buildRelevanceContext({
      message: evaluationCase.message,
      recentHistory: (evaluationCase.recentHistory ?? []).map((content) => ({ content })),
      subjectIds: new Set(evaluationCase.subjectIds),
      now: evaluationCase.now,
    });
    const lexicalOrder = [...evaluationCase.candidates].sort((a, b) =>
      bm25Score(corpus, context, b, weights) - bm25Score(corpus, context, a, weights));
    const embeddingOrder = evaluationCase.candidates
      .filter((candidate) => candidate.cosineSimilarity !== undefined)
      .sort((a, b) => b.cosineSimilarity! - a.cosineSimilarity!);
    const fused = reciprocalRankFusion(
      embeddingOrder.length > 0 ? [lexicalOrder, embeddingOrder] : [lexicalOrder],
    );
    const ranked = lexicalOrder
      .filter((candidate) => !evaluationCase.requireTopicalMatch ||
        bm25LexicalScore(corpus, context, candidate) > 0 || (candidate.cosineSimilarity ?? 0) >= 0.25)
      .sort((a, b) =>
        ((fused.get(b) ?? 0) + (b.relationBoost ?? 0)) -
        ((fused.get(a) ?? 0) + (a.relationBoost ?? 0)));
    // Production selection (selectByRelevance) has no result-COUNT cap at
    // all — only the character budget (maxSerializedChars) below bounds it.
    // Defaulting an unspecified maxResults to 5 here would silently apply a
    // cap production never enforces, understating recall for every
    // collected case that didn't happen to record one.
    const resultLimit = Math.min(evaluationCase.maxResults ?? ranked.length, ranked.length);
    const retrieved: RelevanceCalibrationCandidate[] = [];
    let serializedChars = 0;
    for (const candidate of ranked) {
      if (retrieved.length >= resultLimit) break;
      const size = candidate.serializedChars ?? JSON.stringify(candidate).length;
      if (evaluationCase.maxSerializedChars !== undefined &&
        serializedChars + size > evaluationCase.maxSerializedChars) continue;
      retrieved.push(candidate);
      serializedChars += size;
    }
    const relevant = new Set(evaluationCase.relevantIds);
    const hits = retrieved.filter((candidate) => relevant.has(candidate.id)).length;
    recalls.push(relevant.size > 0 ? hits / relevant.size : hits === 0 ? 1 : 0);
    precisions.push(retrieved.length > 0 ? hits / retrieved.length : relevant.size === 0 ? 1 : 0);

    const firstRelevantRank = retrieved.findIndex((candidate) => relevant.has(candidate.id));
    reciprocalRanks.push(firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0);

    const discountedGain = retrieved.reduce((sum, candidate, rank) =>
      sum + (relevant.has(candidate.id) ? 1 / Math.log2(rank + 2) : 0), 0);
    const idealCount = Math.min(relevant.size, resultLimit);
    let idealGain = 0;
    for (let rank = 0; rank < idealCount; rank++) idealGain += 1 / Math.log2(rank + 2);
    normalizedGains.push(idealGain > 0 ? discountedGain / idealGain : discountedGain === 0 ? 1 : 0);
  }

  const recall = average(recalls);
  const precision = average(precisions);
  const meanReciprocalRank = average(reciprocalRanks);
  const normalizedDiscountedCumulativeGain = average(normalizedGains);
  return {
    recall,
    precision,
    meanReciprocalRank,
    normalizedDiscountedCumulativeGain,
    objective: 0.5 * recall + 0.25 * normalizedDiscountedCumulativeGain +
      0.15 * meanReciprocalRank + 0.1 * precision,
  };
}

export function calibrateBm25Weights(
  cases: readonly RelevanceCalibrationCase[],
  candidates: readonly Readonly<Bm25ScoreWeights>[],
): CalibrationResult[] {
  const calibrationCases = cases.filter((evaluationCase) => evaluationCase.split === "calibration");
  const validationCases = cases.filter((evaluationCase) => evaluationCase.split === "validation");
  return candidates.map((weights) => ({
    weights,
    calibration: evaluateBm25Weights(calibrationCases, weights),
    validation: validationCases.length > 0 ? evaluateBm25Weights(validationCases, weights) : null,
  })).sort((a, b) =>
    b.calibration.objective - a.calibration.objective ||
    a.weights.subjectBoost - b.weights.subjectBoost ||
    a.weights.maxRecencyBoost - b.weights.maxRecencyBoost ||
    a.weights.recencyWindowMs - b.weights.recencyWindowMs);
}

export function bm25WeightGrid(input: {
  subjectBoosts: readonly number[];
  maxRecencyBoosts: readonly number[];
  recencyWindowDays: readonly number[];
}): Bm25ScoreWeights[] {
  const dayMs = 24 * 60 * 60 * 1_000;
  return input.subjectBoosts.flatMap((subjectBoost) =>
    input.maxRecencyBoosts.flatMap((maxRecencyBoost) =>
      input.recencyWindowDays.map((days) => ({
        subjectBoost,
        maxRecencyBoost,
        recencyWindowMs: days * dayMs,
      }))));
}
