import { describe, expect, it } from "vitest";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";
import { assessLayaClassification, layaReplayRequest, parseLayaBaseline } from "../../src/application/chat/laya-contextual-replay.js";

describe("Laya synthetic classification projection", () => {
  const fixture = contextualReplayCases()[0]!;
  it("retains speaker/reply bindings and elapsed time without leaking expected labels", () => {
    const request = layaReplayRequest({ ...fixture, id: "SECRET_FIXTURE", scenario: "SECRET_SCENARIO",
      expectedRelationships: ["elsewhere"], textAllowed: false });
    expect(JSON.stringify(request)).not.toContain("SECRET_");
    expect(JSON.parse(request.state)).toMatchObject({ currentMessageId: fixture.current.messageId, messages: [
      { speakerId: fixture.events[0]!.authorId, millisecondsBeforeCurrent: 3000 },
      { speakerId: "1000000000000000200", replyToMessageId: fixture.events[0]!.messageId, millisecondsBeforeCurrent: 2000 },
      { id: fixture.current.messageId, millisecondsBeforeCurrent: 0 },
    ] });
    expect(request).toEqual(layaReplayRequest(fixture));
    expect(Object.keys(request.questions)).toEqual(["relationship", "intent", "action", "referent"]);
  });
  it("does not reward always-silent classification as correct relationship interpretation", () => {
    expect(assessLayaClassification(fixture, { relationship: "unclear", intent: "abstain", action: "silent", referent: "unresolved" }))
      .toEqual({ relationshipCorrect: false, disallowedReply: false });
    const closing = contextualReplayCases().find((item) => item.scenario === "closing")!;
    expect(assessLayaClassification(closing, { relationship: "elsewhere", intent: "closing", action: "reply", referent: "self_contained" }))
      .toEqual({ relationshipCorrect: true, disallowedReply: true });
  });
  it("changes representation and choice wording independently without label leakage", () => {
    const variant = { format: "dialogue", choices: "short", questions: "separate" } as const;
    const plain = layaReplayRequest(fixture, variant);
    expect(plain.state).toContain("Pinecone (bot)");
    expect(plain.state).toContain("M3 CURRENT | Human 1 | 0 ms");
    expect(plain.state).toContain("reply to M1");
    expect(plain.state).not.toContain(fixture.current.authorId);
    expect(plain.questions.relationship.criteria.followup!.length).toBeLessThan(layaReplayRequest(fixture).questions.relationship.criteria.followup!.length);
    expect(layaReplayRequest(fixture, { ...variant, choices: "detailed" }).questions).toEqual(layaReplayRequest(fixture).questions);
    expect(layaReplayRequest(fixture, { ...variant, format: "json" }).state).toBe(layaReplayRequest(fixture).state);
    expect(layaReplayRequest({ ...fixture, id: "SECRET_ID", scenario: "SECRET_SCENARIO", expectedRelationships: ["elsewhere"], textAllowed: false }, variant)).toEqual(plain);
    expect(layaReplayRequest(fixture, { ...variant, questions: "together" })).toEqual(plain);
  });
  it("requires a live matching revision baseline and rejects duplicate or mismatched cases", () => {
    const row = { id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: "valid", durationMs: 20,
      relationship: "followup", intent: "answer", action: "reply", referent: "context_linked" };
    const report = { summary: { fixtureRevision: 3, mode: "live_synthetic_decision_replay" }, results: [row] };
    expect(parseLayaBaseline(report, [fixture]).get(fixture.id)).toEqual(row);
    expect(() => parseLayaBaseline({ ...report, summary: { ...report.summary, fixtureRevision: 2 } }, [fixture])).toThrow();
    expect(() => parseLayaBaseline({ ...report, results: [row, row] }, [fixture])).toThrow();
    expect(() => parseLayaBaseline({ ...report, results: [{ ...row, language: "en" }] }, [fixture])).toThrow();
    expect(() => parseLayaBaseline({ ...report, summary: { ...report.summary, mode: "fixture_inventory_only" } }, [fixture])).toThrow();
  });
});
