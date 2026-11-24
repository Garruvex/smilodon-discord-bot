import { describe, expect, it } from "vitest";

import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { continuityTerms, type PriorAnswerAnchorMode } from "../../src/application/chat/prior-answer-anchor.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const window = { count: 40, budget: 12_000, burstIds: [] };

// alice asked for ramen places and the bot answered; then 50 unrelated messages pushed both out of
// the 40-message window before the current speaker followed up.
async function channel(current: string, options: { filler?: number; author?: string; answerProof?: boolean; replyTo?: string } = {}): Promise<ReturnType<typeof guardedFixture>> {
  const fixture = guardedFixture(guardedEvent("question", 1_000, "which ramen places near the station are good?"));
  const answer = "Try Menya Kaiko, Ichiran, or the tonkotsu stall by exit 3.";
  const lease = await GuardedConversationContext.open(fixture.port, window);
  fixture.sources.set("answer", { event: guardedEvent("answer", 1_100, answer, "bot", { replyToMessageId: "question" }), origin: "chat", sourceMessageId: "question",
    provenance: options.answerProof === false ? null : lease.provenance(answer) });
  for (let index = 0; index < (options.filler ?? 50); index++) fixture.add(guardedEvent(`filler-${index}`, 2_000 + index, `filler chatter number ${index} about the match tonight`, "bob"));
  fixture.add(guardedEvent("current", 9_000, current, options.author ?? "carol", options.replyTo ? { replyToMessageId: options.replyTo } : {}));
  fixture.actors.set("carol", { id: "carol", displayName: "carol", roleNames: [], kind: "human" });
  fixture.port.sourceMessageId = "current"; fixture.port.actorId = options.author ?? "carol";
  return fixture;
}
const open = (fixture: ReturnType<typeof guardedFixture>, mode: PriorAnswerAnchorMode): Promise<GuardedConversationContext> =>
  GuardedConversationContext.open(fixture.port, { ...window, priorAnswerAnchor: mode });

describe("prior-answer anchor", () => {
  it("adds the earlier answer and its question when a follow-up's referent left the window", async () => {
    const lease = await open(await channel("what about the second one, is it open late?"), "on");
    expect(lease.anchor.map((event) => event.messageId)).toEqual(["question", "answer"]);
    expect(lease.history.map((event) => event.messageId)).not.toContain("answer");
    expect(lease.report).toMatchObject({ anchor: 2, anchorMatch: "beyond" });
    // The anchored answer is evidence like any other input, so the reply's proof cites it.
    expect(lease.provenance("It closes at 11.")!.dependencies.map((dependency) => dependency.messageId)).toEqual(expect.arrayContaining(["question", "answer"]));
  });

  it("finds the answer by a distinctive shared term when the message is not follow-up shaped", async () => {
    const lease = await open(await channel("Ichiran is open late, right?"), "on");
    expect(lease.anchor.map((event) => event.messageId)).toEqual(["question", "answer"]);
  });

  it("only reports the match in shadow mode and does nothing when off", async () => {
    const shadow = await open(await channel("what about the second one?"), "shadow");
    expect(shadow.anchor).toEqual([]);
    expect(shadow.report).toMatchObject({ anchor: 0, anchorMatch: "beyond" });
    const off = await open(await channel("what about the second one?"), "off");
    expect(off.anchor).toEqual([]);
    expect(off.report.anchorMatch).toBeUndefined();
  });

  it("adds nothing when the referent is still in the window", async () => {
    const lease = await open(await channel("what about the second one?", { filler: 5 }), "on");
    expect(lease.anchor).toEqual([]);
    expect(lease.history.map((event) => event.messageId)).toContain("answer");
    expect(lease.report.anchorMatch).toBe("window");
  });

  it("never anchors an answer whose proof does not verify, or anything without a match", async () => {
    expect((await open(await channel("what about the second one?", { answerProof: false }), "on")).anchor).toEqual([]);
    const unrelated = await open(await channel("anyone watching the match tonight later than nine"), "on");
    expect(unrelated.anchor).toEqual([]);
    expect(unrelated.report.anchorMatch).toBe("none");
  });

  it("leaves an explicit Discord reply to the reply chain", async () => {
    const lease = await open(await channel("what about the second one?", { replyTo: "answer" }), "on");
    expect(lease.replyChain.map((event) => event.messageId)).toContain("answer");
    expect(lease.anchor).toEqual([]);
  });

  it("splits Chinese text into bigrams and stems distinctive Latin words", () => {
    expect([...continuityTerms("推薦的拉麵 Ichiran")]).toEqual(expect.arrayContaining(["ichir", "推薦", "拉麵"]));
    expect(continuityTerms("thinking")).toEqual(continuityTerms("think"));
    expect(continuityTerms("what about the one")).toEqual(new Set());
  });

  it("matches a follow-up that names the person the answer was for", async () => {
    // bob's answer is newer, but the speaker asks about the one given to alice.
    const fixture = await channel("hey what did you tell alice yesterday");
    fixture.sources.set("bob-q", { event: guardedEvent("bob-q", 8_000, "<@bot> cats or dogs", "bob"), origin: "human", provenance: null });
    fixture.port.sourceMessageId = "bob-q"; fixture.port.actorId = "bob";
    const bobLease = await GuardedConversationContext.open(fixture.port, window);
    fixture.sources.set("bob-a", { event: guardedEvent("bob-a", 8_100, "Cats, obviously.", "bot", { replyToMessageId: "bob-q" }), origin: "chat", sourceMessageId: "bob-q",
      provenance: bobLease.provenance("Cats, obviously.") });
    fixture.port.sourceMessageId = "current"; fixture.port.actorId = "carol";
    const anchored = await open(fixture, "on");
    expect(anchored.anchor.map((event) => event.messageId)).toEqual(["question", "answer"]);
  });
});
