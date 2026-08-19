import { describe, expect, it } from "vitest";

import { buildRelevanceContext, cosineSimilarity, scoreRecord, selectByRelevance } from "../../src/application/chat/memory-relevance.js";

describe("memory-relevance", () => {
  it("scores keyword overlap with the current turn above no match", () => {
    const context = buildRelevanceContext({
      message: "what's my favorite fruit again?",
      recentHistory: [],
      subjectIds: new Set(),
      now: 1_000,
    });
    const matching = scoreRecord(context, {
      subjectId: "someone-else", topic: "preference", slot: "food.fruit", statement: "likes green apples", updatedAt: 1_000,
    });
    const nonMatching = scoreRecord(context, {
      subjectId: "someone-else", topic: "gaming", slot: "role.overwatch", statement: "plays support", updatedAt: 1_000,
    });
    expect(matching).toBeGreaterThan(nonMatching);
  });

  it("boosts records whose subject is present in the conversation", () => {
    const context = buildRelevanceContext({
      message: "hello there",
      recentHistory: [],
      subjectIds: new Set(["user-1"]),
      now: 1_000,
    });
    const aboutSubject = scoreRecord(context, {
      subjectId: "user-1", topic: "identity", slot: "role", statement: "is a moderator", updatedAt: 1_000,
    });
    const aboutSomeoneElse = scoreRecord(context, {
      subjectId: "user-2", topic: "identity", slot: "role", statement: "is a moderator", updatedAt: 1_000,
    });
    expect(aboutSubject).toBeGreaterThan(aboutSomeoneElse);
  });

  it("falls back to recency when nothing keyword-matches (cold start still returns something)", () => {
    const context = buildRelevanceContext({
      message: "unrelated text with no overlap",
      recentHistory: [],
      subjectIds: new Set(),
      now: 1_000_000,
    });
    const older = scoreRecord(context, {
      subjectId: "x", topic: "other", slot: "a", statement: "some old fact", updatedAt: 0,
    });
    const newer = scoreRecord(context, {
      subjectId: "x", topic: "other", slot: "b", statement: "some new fact", updatedAt: 999_000,
    });
    expect(newer).toBeGreaterThan(older);
  });

  it("always keeps at least the top-ranked record even if it alone exceeds the char budget", () => {
    const records = [{ statement: "x".repeat(10_000) }];
    const selected = selectByRelevance(records, () => 1, 100);
    expect(selected).toHaveLength(1);
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
