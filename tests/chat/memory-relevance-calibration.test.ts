import { describe, expect, it } from "vitest";

import {
  bm25WeightGrid,
  calibrateBm25Weights,
  evaluateBm25Weights,
  type RelevanceCalibrationCase,
} from "../../src/application/chat/memory-relevance-calibration.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  defaultBm25ScoreWeights,
} from "../../src/application/chat/memory-relevance.js";

const dayMs = 24 * 60 * 60 * 1_000;

describe("memory relevance calibration", () => {
  it("keeps the existing production behavior as the default weight set", () => {
    const record = {
      subjectId: "alice", topic: "identity", slot: "role",
      statement: "works as an engineer", updatedAt: 10 * dayMs,
    };
    const corpus = buildBm25Corpus([record]);
    const context = buildRelevanceContext({
      message: "unrelated query", recentHistory: [], subjectIds: new Set(["alice"]), now: 10 * dayMs,
    });

    expect(bm25Score(corpus, context, record)).toBe(5);
    expect(defaultBm25ScoreWeights).toEqual({
      subjectBoost: 3,
      maxRecencyBoost: 2,
      recencyWindowMs: 30 * dayMs,
    });
  });

  it("accepts injected weights without changing lexical BM25 behavior", () => {
    const record = {
      subjectId: "alice", topic: "preference", slot: "fruit",
      statement: "likes apples", updatedAt: 0,
    };
    const corpus = buildBm25Corpus([record]);
    const context = buildRelevanceContext({
      message: "apples", recentHistory: [], subjectIds: new Set(["alice"]), now: 10 * dayMs,
    });
    const noPriors = bm25Score(corpus, context, record, {
      subjectBoost: 0, maxRecencyBoost: 0, recencyWindowMs: 0,
    });
    const withPriors = bm25Score(corpus, context, record, {
      subjectBoost: 1.5, maxRecencyBoost: 0.5, recencyWindowMs: 20 * dayMs,
    });

    expect(withPriors - noPriors).toBeCloseTo(1.75);
  });

  it("measures rankings and chooses weights from calibration cases only", () => {
    const cases: RelevanceCalibrationCase[] = [
      {
        id: "calibration-subject", split: "calibration", message: "no matching words",
        subjectIds: ["alice"], now: 10 * dayMs, maxResults: 1,
        candidates: [
          { id: "relevant", subjectId: "alice", topic: "food", slot: "fruit", statement: "likes apples", updatedAt: 0 },
          { id: "noise", subjectId: "bob", topic: "other", slot: "other", statement: "no matching words", updatedAt: 10 * dayMs },
        ],
        relevantIds: ["relevant"],
      },
      {
        id: "validation-lexical", split: "validation", message: "camera",
        subjectIds: ["alice"], now: 10 * dayMs, maxResults: 1,
        candidates: [
          { id: "relevant", subjectId: "bob", topic: "camera", slot: "model", statement: "camera model", updatedAt: 0 },
          { id: "noise", subjectId: "alice", topic: "other", slot: "other", statement: "unrelated", updatedAt: 10 * dayMs },
        ],
        relevantIds: ["relevant"],
      },
    ];
    const grid = bm25WeightGrid({
      subjectBoosts: [0, 3], maxRecencyBoosts: [0], recencyWindowDays: [30],
    });
    const results = calibrateBm25Weights(cases, grid);

    expect(results[0]!.weights.subjectBoost).toBe(3);
    expect(results[0]!.calibration.objective).toBe(1);
    expect(results[0]!.validation?.objective).toBe(0);
    expect(evaluateBm25Weights(cases, results[0]!.weights).objective).toBe(0.5);
  });

  it("does not silently cap retrieval at 5 results when a case omits maxResults", () => {
    // Production selection (selectByRelevance) has no result-COUNT cap at
    // all — only a character budget. A collected trace that doesn't record
    // maxResults must be evaluated the same way, not against a fabricated
    // default of 5 that would understate recall for any case where the
    // truly-relevant candidate doesn't happen to rank in the top 5.
    const candidates = Array.from({ length: 5 }, (_unused, i) => ({
      id: `noise-${i}`, subjectId: "alice", topic: "other", slot: `slot-${i}`,
      statement: "apple apple apple apple", updatedAt: 10 * dayMs,
    }));
    candidates.push({
      // Zero lexical overlap with the query and the oldest updatedAt — ranks
      // dead last against the 5 noise candidates above.
      id: "relevant", subjectId: "alice", topic: "food", slot: "fruit", statement: "completely unrelated wording", updatedAt: 0,
    });
    const caseWithoutMaxResults: RelevanceCalibrationCase = {
      id: "no-max-results", split: "calibration", message: "apple",
      subjectIds: ["alice"], now: 10 * dayMs,
      candidates, relevantIds: ["relevant"],
      // maxResults intentionally omitted.
    };

    const metrics = evaluateBm25Weights([caseWithoutMaxResults], defaultBm25ScoreWeights);
    expect(metrics.recall).toBe(1);
  });

  it("treats an empty relevantIds set as a valid 'nothing here was relevant' label, penalizing any retrieval as a false positive", () => {
    const negativeCase: RelevanceCalibrationCase = {
      id: "nothing-relevant", split: "calibration", message: "apple",
      subjectIds: ["alice"], now: 10 * dayMs,
      candidates: [
        { id: "a", subjectId: "alice", topic: "food", slot: "fruit", statement: "apple", updatedAt: 10 * dayMs },
      ],
      relevantIds: [],
    };

    const metrics = evaluateBm25Weights([negativeCase], defaultBm25ScoreWeights);
    expect(metrics.precision).toBe(0);
  });
});
