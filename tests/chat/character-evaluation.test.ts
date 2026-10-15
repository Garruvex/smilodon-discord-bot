import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CharacterEvaluationStore, replayCharacterConversations } from "../../src/application/chat/character-evaluation.js";

describe("human character evaluation", () => {
  it("requires consent and anonymization before any replay calls, then runs chronologically", async () => {
    const turns = [20, 10].map((timestampMs) => ({ timestampMs, channelId: "channel", speakerId: "member", message: `at ${timestampMs}` }));
    const run = vi.fn((turn: { timestampMs: number }) => Promise.resolve(turn.timestampMs));
    await expect(replayCharacterConversations({ consented: false, anonymized: true, turns }, run)).rejects.toThrow();
    await expect(replayCharacterConversations({ consented: true, anonymized: false, turns }, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(await replayCharacterConversations({ consented: true, anonymized: true, turns }, run)).toEqual([{ turn: 0, output: 10 }, { turn: 1, output: 20 }]);
  });
  it("records hypothetical output separately from delivery and clears review metadata on forgetting", async () => {
    const store = new CharacterEvaluationStore(mkdtempSync(join(tmpdir(), "participation-review-")));
    await store.record("guild", "decision", { proposedAction: "reply", shadow: true });
    await store.record("guild", "delivery", { delivered: false, shadow: true });
    expect((await store.list("guild")).map((record) => record.kind)).toEqual(["decision", "delivery"]);
    await store.forget("guild"); expect(await store.list("guild")).toEqual([]);
  });
  it("removes only review records linked to an excluded source and rejects stale queued records", async () => {
    const store = new CharacterEvaluationStore(mkdtempSync(join(tmpdir(), "participation-source-")));
    await store.record("guild", "decision", { sourceMessageId: "deleted", recipientEvidence: ["deleted"] });
    await store.record("guild", "decision", { sourceMessageId: "kept" });
    await store.excludeSource("guild", "deleted");
    await store.record("guild", "delivery", { sourceMessageId: "deleted", delivered: false });
    expect((await store.list("guild")).map((record) => record.data)).toEqual([{ sourceMessageId: "kept" }]);
  });
  it("serializes review writes, scopes them to the guild and expires old records", async () => {
    const store = new CharacterEvaluationStore(mkdtempSync(join(tmpdir(), "character-review-")));
    await Promise.all([store.record("guild", "flag", { category: "wrong-person" }), store.record("guild", "label", { preference: "A" })]);
    expect(await store.list("guild")).toHaveLength(2);
    expect(await store.list("other")).toEqual([]);
    expect(await store.list("guild", Date.now() + 31 * 86_400_000)).toEqual([]);
    await expect(store.list("../outside")).rejects.toThrow("Invalid evaluation guild ID");
  });
});
