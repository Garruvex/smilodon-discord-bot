import { describe, expect, it } from "vitest";

import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
  selectByRelevance,
  tokenize,
} from "../../src/application/chat/memory-relevance.js";

describe("tokenize", () => {
  it("tokenizes English exactly as before CJK support was added — space-delimited words, 3+ chars, lowercased", () => {
    expect([...tokenize("The Quick Brown fox jumps over a lazy dog42")].sort())
      .toEqual(["brown", "dog42", "fox", "jumps", "lazy", "over", "quick", "the"]);
  });

  it("segments Chinese text into real word tokens instead of producing nothing", () => {
    const tokens = tokenize("我今天期中考炸了");
    expect(tokens.size).toBeGreaterThan(0);
    expect(tokens.has("期中考")).toBe(true);
  });

  it("filters common Chinese function words the way English stopwords like 'the'/'a' are implicitly excluded by the length cutoff", () => {
    const tokens = tokenize("這個是我的東西");
    expect(tokens.has("這個")).toBe(false);
    expect(tokens.has("是")).toBe(false);
  });

  it("tokenizes mixed English/Chinese text, extracting terms from both scripts", () => {
    const tokens = tokenize("today's 期中考 was rough lol");
    expect(tokens.has("today")).toBe(true);
    expect(tokens.has("期中考")).toBe(true);
  });
});

describe("memory-relevance", () => {
  it("scores keyword overlap with the current turn above no match", () => {
    const context = buildRelevanceContext({
      message: "what's my favorite fruit again?",
      recentHistory: [],
      subjectIds: new Set(),
      now: 1_000,
    });
    const matchingRecord = {
      subjectId: "someone-else", topic: "preference", slot: "food.fruit", statement: "likes green apples", updatedAt: 1_000,
    };
    const nonMatchingRecord = {
      subjectId: "someone-else", topic: "gaming", slot: "role.overwatch", statement: "plays support", updatedAt: 1_000,
    };
    const corpus = buildBm25Corpus([matchingRecord, nonMatchingRecord]);
    const matching = bm25Score(corpus, context, matchingRecord);
    const nonMatching = bm25Score(corpus, context, nonMatchingRecord);
    expect(matching).toBeGreaterThan(nonMatching);
  });

  it("boosts records whose subject is present in the conversation", () => {
    const context = buildRelevanceContext({
      message: "hello there",
      recentHistory: [],
      subjectIds: new Set(["user-1"]),
      now: 1_000,
    });
    const aboutSubjectRecord = {
      subjectId: "user-1", topic: "identity", slot: "role", statement: "is a moderator", updatedAt: 1_000,
    };
    const aboutSomeoneElseRecord = {
      subjectId: "user-2", topic: "identity", slot: "role", statement: "is a moderator", updatedAt: 1_000,
    };
    const corpus = buildBm25Corpus([aboutSubjectRecord, aboutSomeoneElseRecord]);
    const aboutSubject = bm25Score(corpus, context, aboutSubjectRecord);
    const aboutSomeoneElse = bm25Score(corpus, context, aboutSomeoneElseRecord);
    expect(aboutSubject).toBeGreaterThan(aboutSomeoneElse);
  });

  it("falls back to recency when nothing keyword-matches (cold start still returns something)", () => {
    const context = buildRelevanceContext({
      message: "unrelated text with no overlap",
      recentHistory: [],
      subjectIds: new Set(),
      now: 1_000_000,
    });
    const olderRecord = {
      subjectId: "x", topic: "other", slot: "a", statement: "some old fact", updatedAt: 0,
    };
    const newerRecord = {
      subjectId: "x", topic: "other", slot: "b", statement: "some new fact", updatedAt: 999_000,
    };
    const corpus = buildBm25Corpus([olderRecord, newerRecord]);
    const older = bm25Score(corpus, context, olderRecord);
    const newer = bm25Score(corpus, context, newerRecord);
    expect(newer).toBeGreaterThan(older);
  });

  it("fuses two rankings via reciprocal rank fusion, favoring items ranked highly in both", () => {
    const items = ["a", "b", "c"];
    const rankingOne = ["a", "b", "c"];
    const rankingTwo = ["b", "a", "c"];
    const fused = reciprocalRankFusion([rankingOne, rankingTwo]);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("c")!);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("c")!);
    expect([...items].sort((x, y) => fused.get(y)! - fused.get(x)!)[2]).toBe("c");
  });

  it("skips an oversized record and continues looking for records that fit", () => {
    const oversized = { id: "oversized", statement: "x".repeat(10_000) };
    const fitting = { id: "fitting", statement: "small" };
    const selected = selectByRelevance(
      [oversized, fitting],
      (record) => record === oversized ? 2 : 1,
      100,
    );
    expect(selected).toEqual([fitting]);
  });

  it("stops adding records once the char budget is exhausted", () => {
    const records = Array.from({ length: 50 }, (_, index) => ({ statement: `record-${index}` }));
    const selected = selectByRelevance(records, () => 1, 200);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(records.length);
  });

  it("ranks by score descending", () => {
    const records = [
      { id: "low", statement: "s" },
      { id: "high", statement: "s" },
      { id: "mid", statement: "s" },
    ];
    const scores: Record<string, number> = { low: 1, high: 3, mid: 2 };
    const selected = selectByRelevance(records, (record) => scores[record.id]!, 10_000);
    expect(selected.map((record) => record.id)).toEqual(["high", "mid", "low"]);
  });

  it("computes the char budget from the prompt projection, not the raw record", () => {
    // A field the projection strips (e.g. a large embedding vector) must not
    // count against the char budget — only what's actually sent to the model.
    const records = [
      { id: "a", statement: "s", embedding: Array(5_000).fill(0.123456) },
      { id: "b", statement: "s", embedding: Array(5_000).fill(0.123456) },
    ];
    const selected = selectByRelevance(
      records,
      () => 1,
      100,
      (record) => ({ id: record.id, statement: record.statement }),
    );
    expect(selected).toHaveLength(2);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for empty or mismatched-length vectors instead of throwing", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("clamps a negative cosine to 0 rather than returning a negative score", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });
});
