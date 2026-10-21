import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedConversationContext, contextSourceHash, guardedAssetsHash, isGuardedContext, projectDecisionContext, type GuardedContextSource } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";

afterEach(() => vi.useRealTimers());
const policy = { count: 40, budget: 12000, burstIds: [] };

describe("guarded conversation context", () => {
  it("loads only eligible images, preserving reply/history identity and attachment dependencies", async () => {
    const fixture = guardedFixture(guardedEvent("current", 4000, "What do these pictures show?", "alice", { replyToMessageId: "old" }));
    for (const [id, time] of [["old", 1000], ["recent", 2000], ["hidden", 3000]] as const) {
      fixture.add(guardedEvent(id, time, "image"));
      fixture.sources.get(id)!.assets = [{ id: `asset-${id}`, contentType: "image/png", size: 10 }];
    }
    fixture.denied.add("hidden");
    const load = vi.fn(() => Promise.resolve("data:image/png;base64,aGVsbG8=")); fixture.port.loadAsset = load;
    const context = await GuardedConversationContext.open(fixture.port, policy);
    const images = await context.images(2);
    expect(images.map(({ source, sourceMessageId }) => ({ source, sourceMessageId }))).toEqual([
      { source: "reply_chain", sourceMessageId: "old" }, { source: "channel_history", sourceMessageId: "recent" },
    ]);
    expect(load.mock.calls).toHaveLength(2);
    expect(context.provenance("answer")?.dependencies.filter((source) => source.assetsHash).map((source) => source.messageId).sort()).toEqual(["old", "recent"]);
    fixture.sources.get("old")!.assets = [];
    expect(await context.validate()).toBe(false);
  });

  it("requires an attachment-bound output origin before reusing a bot image", async () => {
    const fixture = guardedFixture(guardedEvent("question", 1000, "draw a cat"));
    const prior = await GuardedConversationContext.open(fixture.port, policy);
    const assets = [{ id: "generated", contentType: "image/png", size: 10 }];
    const proof = prior.provenance("a cat")!;
    fixture.sources.set("answer", { event: guardedEvent("answer", 2000, "a cat", "bot"), origin: "chat", assets, provenance: proof });
    fixture.add(guardedEvent("current", 3000, "change that picture", "alice", { replyToMessageId: "answer" })); fixture.port.sourceMessageId = "current";
    const load = vi.fn(() => Promise.resolve("data:image/png;base64,aGVsbG8=")); fixture.port.loadAsset = load;
    const unbound = await GuardedConversationContext.open(fixture.port, policy);
    expect(await unbound.images(2)).toEqual([]); expect(load).not.toHaveBeenCalled();
    fixture.sources.get("answer")!.provenance = { ...proof, outputAssetsHash: guardedAssetsHash(assets) };
    const bound = await GuardedConversationContext.open(fixture.port, policy);
    expect(await bound.images(2)).toHaveLength(1);
    fixture.sources.get("answer")!.assets = [{ ...assets[0]!, id: "replacement" }];
    expect(await bound.validate()).toBe(false);
  });

  it("preserves public search lineage through reused answers without widening protected-source access", async () => {
    const fixture = guardedFixture(guardedEvent("question", 1000, "Find public information"));
    const original = await GuardedConversationContext.open(fixture.port, policy);
    original.recordPublicWebSearch([{ title: "Source", url: "https://example.com/source" }]);
    const proof = original.provenance("searched answer")!;
    expect(proof.publicWeb?.citationHashes).toHaveLength(1);
    expect(JSON.stringify(proof)).not.toContain("https://example.com");
    fixture.sources.set("answer", { event: guardedEvent("answer", 2000, "searched answer", "bot"), origin: "chat", provenance: proof });
    fixture.add(guardedEvent("current", 3000, "What did you find?")); fixture.port.sourceMessageId = "current";
    const followup = await GuardedConversationContext.open(fixture.port, policy);
    expect(followup.history.map((event) => event.messageId)).toContain("answer");
    expect(followup.provenance("followup")?.publicWeb).toEqual(proof.publicWeb);
    fixture.denied.add("question");
    expect(await followup.validate()).toBe(false);
    const next = await GuardedConversationContext.open(fixture.port, policy);
    expect(next.history.map((event) => event.messageId)).not.toContain("answer");
  });

  it("uses a fresh shared baseline across long gaps and excludes unreadable authors without spending X", async () => {
    const fixture = guardedFixture(guardedEvent("current", 10_000_000, "@bot"));
    for (let index = 1; index <= 150; index++) {
      fixture.add(guardedEvent(`m${index}`, index, `message ${index}`));
      if (index > 50) fixture.denied.add(`m${index}`);
    }
    const context = await GuardedConversationContext.open(fixture.port, policy);
    expect(context.history.map((event) => event.messageId)).toEqual(Array.from({ length: 40 }, (_, index) => `m${index + 11}`));
    expect(context.report).toMatchObject({ pages: 2, eligible: 40, omitted: 100 });
    expect(isGuardedContext(context)).toBe(true); expect(isGuardedContext({ filtered: true })).toBe(false);
  });

  it("preserves distant explicit reply ancestry and its grounding in the decision projection", async () => {
    const fixture = guardedFixture(guardedEvent("current", 10_000_000, "what about this?", "alice", { replyToMessageId: "old" }));
    fixture.add(guardedEvent("old", 1, "An old substantive request", "bob"));
    const context = await GuardedConversationContext.open(fixture.port, policy);
    expect(context.replyChain.map((event) => event.messageId)).toEqual(["old"]);
    expect(context.current.replyToAuthorId).toBe("bob");
    const request = decisionRequest({ replyChain: context.replyChain, channelHistory: Array.from({ length: 40 }, (_, index) => guardedEvent(`recent${index}`, index, "recent")) });
    expect(projectDecisionContext(request, 10).map((event) => event.messageId)).toContain("old");
  });

  it("bounds targeted backward expansion to five additional pages", async () => {
    const fixture = guardedFixture(guardedEvent("current", 2000, "the earlier apples question"));
    for (let index = 1; index <= 1000; index++) fixture.add(guardedEvent(`m${index}`, index, "apples"));
    const context = await GuardedConversationContext.open(fixture.port, policy);
    expect(context.report).toMatchObject({ pages: 3, targetedPages: 5, fetched: 800, status: "scan_cap" });
    expect(context.history.length).toBeLessThanOrEqual(48);
    expect(context.history.some((event) => event.timestampMs < 960)).toBe(true);
    expect(fixture.port.page).toHaveBeenCalledTimes(8);
  });

  it.each(["delete", "edit", "denied", "policy"] as const)("invalidates a lease on %s before reuse or delivery", async (change) => {
    const fixture = guardedFixture(); fixture.add(guardedEvent("old", 1, "SECRET_CONTEXT"));
    const context = await GuardedConversationContext.open(fixture.port, policy);
    if (change === "delete") fixture.sources.delete("old");
    if (change === "edit") fixture.sources.get("old")!.event.content = "edited";
    if (change === "denied") fixture.denied.add("old");
    if (change === "policy") fixture.setPolicy(false);
    expect(await context.validate()).toBe(false);
    expect(context.provenance("answer")).toBeNull();
  });

  it("reuses complete bot and session text only while all original sources and actual deliveries remain valid", async () => {
    const fixture = guardedFixture(guardedEvent("question", 1000, "original question"));
    const prior = await GuardedConversationContext.open(fixture.port, policy);
    const proof = prior.provenance("specific answer")!;
    expect(proof.coverage).toBe("complete"); expect(proof.dependencies[0]?.representationHash).toBe(contextSourceHash(fixture.sources.get("question")!.event));
    const bot = guardedEvent("answer", 2000, "specific answer", "bot", { replyToMessageId: "question" });
    fixture.sources.set("answer", { event: bot, origin: "chat", provenance: proof });
    fixture.add(guardedEvent("current", 3000, "followup")); fixture.port.sourceMessageId = "current";
    const session = { user: { content: "original question", createdAt: 1000, sourceMessageId: "question" },
      assistant: { content: "specific answer", createdAt: 2000, messageIds: ["answer"] }, contextProvenance: proof };
    const context = await GuardedConversationContext.open(fixture.port, policy);
    expect(context.history.map((event) => event.messageId)).toContain("answer");
    const prepareValidation = vi.fn(() => Promise.resolve()); fixture.port.prepareValidation = prepareValidation;
    expect(await context.sessions([session])).toEqual([session]);
    expect(prepareValidation).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining(["current", "question", "answer"]), expect.any(AbortSignal));
    fixture.sources.delete("question");
    expect(await context.validate()).toBe(false);
    const later = await GuardedConversationContext.open(fixture.port, policy);
    expect(later.history.map((event) => event.messageId)).not.toContain("answer");
    expect(await later.sessions([session])).toEqual([]);
  });

  it("rejects partial bot provenance, altered output, and another user's session", async () => {
    const fixture = guardedFixture(guardedEvent("question", 1000, "question"));
    const original = await GuardedConversationContext.open(fixture.port, policy); const proof = original.provenance("answer")!;
    fixture.sources.set("bot", { event: guardedEvent("bot", 2000, "tampered", "bot"), origin: "chat", provenance: proof });
    fixture.sources.set("legacy", { event: guardedEvent("legacy", 2100, "SECRET_LEGACY", "bot"), origin: "chat", provenance: { ...proof, coverage: "partial", unresolved: ["unguarded_prompt_sources"] } });
    fixture.add(guardedEvent("current", 3000, "hi", "bob")); fixture.port.sourceMessageId = "current"; fixture.port.actorId = "bob";
    const context = await GuardedConversationContext.open(fixture.port, policy);
    expect(context.history.map((event) => event.messageId)).toEqual(["question"]);
    expect(await context.sessions([{ user: { content: "question", createdAt: 1000, sourceMessageId: "question" },
      assistant: { content: "answer", createdAt: 2000, messageIds: ["bot"] }, contextProvenance: proof }])).toEqual([]);
  });

  it("filters reaction actors and rechecks their current eligibility", async () => {
    const fixture = guardedFixture(guardedEvent("question", 1000, "original question"));
    const original = await GuardedConversationContext.open(fixture.port, policy);
    fixture.sources.set("current", { event: guardedEvent("current", 4000, "answer", "bot"), origin: "chat", provenance: original.provenance("answer") });
    fixture.port.sourceMessageId = "current"; fixture.port.actorId = null;
    const event = { type: "reaction_snapshot" as const, channelId: "channel", targetMessageId: "current", targetAuthorId: "bot", observedAt: 5000,
      complete: true, exactReactionTimes: "unknown" as const, reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice", "denied"] }] };
    const context = await GuardedConversationContext.open(fixture.port, { ...policy, event });
    expect(context.currentEvent).toMatchObject({ reactions: [{ actorIds: ["alice"] }] });
    expect(context.provenance("answer")?.actors?.map((actor) => actor.userId)).toEqual(["alice"]);
    await expect(GuardedConversationContext.open(fixture.port, { ...policy, event, minReactors: 2 })).rejects.toBeInstanceOf(SocialOutputSuppressed);
    fixture.actors.delete("alice"); expect(await context.validate()).toBe(false);
  });

  it("bounds stalled historical work and emits coverage without waiting for Discord", async () => {
    vi.useFakeTimers(); const fixture = guardedFixture();
    fixture.port.read = (): Promise<GuardedContextSource | null> => new Promise(() => {}); const report = vi.fn(); fixture.port.coverage = report;
    const pending = GuardedConversationContext.open(fixture.port, policy);
    const assertion = expect(pending).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await vi.advanceTimersByTimeAsync(8000); await assertion;
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: "deadline" }));
    expect(fixture.port.page).not.toHaveBeenCalled();
  });

  it("identifies a stalled session phase and cancels within its existing deadline", async () => {
    vi.useFakeTimers(); const fixture = guardedFixture();
    const context = await GuardedConversationContext.open(fixture.port, policy);
    const work = vi.fn(); fixture.port.work = work;
    fixture.port.prepareValidation = (): Promise<void> => new Promise(() => {});
    const pending = context.sessions([{ user: { content: context.current.content, createdAt: 4000, sourceMessageId: "current" },
      assistant: { content: "answer", createdAt: 4500, messageIds: ["delivered"] }, contextProvenance: context.provenance("answer") }]);
    const assertion = expect(pending).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await vi.advanceTimersByTimeAsync(8000); await assertion;
    expect(work).toHaveBeenCalledExactlyOnceWith("sessions", "deadline", 8000);
    expect(context.provenance("reply")).toBeNull();
  });
});
