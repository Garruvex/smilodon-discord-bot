import { describe, expect, it } from "vitest";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";
describe("synthetic contextual replay inventory", () => {
  it("covers 216 controlled variations across languages, gaps and speakers", () => {
    const cases = contextualReplayCases();
    expect(cases).toHaveLength(216);
    expect(new Set(cases.map((item) => item.id)).size).toBe(216);
    expect(new Set(cases.map((item) => item.language))).toEqual(new Set(["zh-TW", "en", "ja"]));
    for (const item of cases) {
      expect(item.events.every((event) => event.timestampMs < item.current.timestampMs)).toBe(true);
      if (item.current.replyToMessageId) expect(item.events.find((event) => event.messageId === item.current.replyToMessageId)?.authorId).toBe(item.current.replyToAuthorId);
      expect(item.expectedRelationships.length).toBeGreaterThan(0);
      if (item.scenario === "answer" && item.id.endsWith("interleaved")) expect(item.expectedRelationships).toEqual(["followup"]);
    }
  });
});
