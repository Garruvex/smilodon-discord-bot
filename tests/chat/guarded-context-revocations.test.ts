import { describe, expect, it, vi } from "vitest";
import { contextSourceHash, GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import { hashContent } from "../../src/application/assets/content-hash.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

type Dependency = ContextProvenance["dependencies"][number];
const policy = { count: 40, budget: 12000, burstIds: [] };

// A3: a committed revocation (an observed Discord delete) must stop every later read and effect from
// using the deleted message or anything derived from it, whoever wrote it and whatever is cached.
interface Setup {
  fixture: ReturnType<typeof guardedFixture>; revoked: Set<string>; store: { failing: boolean };
  dependency: (id: string, projection?: Dependency["projection"]) => Dependency; reply: (id: string, time: number, dependencies: readonly Dependency[]) => void;
}
async function setup(mode: "stored" | "refetch" = "stored"): Promise<Setup> {
  const fixture = guardedFixture(guardedEvent("current", 100_000, "<@bot> what did you say?"));
  if (mode === "stored") fixture.port.sourcesAllowed = vi.fn((sources: readonly unknown[]) => Promise.resolve(sources.map(() => true)));
  const revoked = new Set<string>(); const store = { failing: false };
  fixture.port.revoked = vi.fn((ids: readonly string[]) => store.failing ? Promise.reject(new Error("database unavailable")) : Promise.resolve(ids.map((id) => revoked.has(id))));
  const template = (await GuardedConversationContext.open(fixture.port, policy)).provenance("template")!;
  const dependency = (id: string, projection?: Dependency["projection"]): Dependency => {
    const event = fixture.sources.get(id)!.event;
    return { guildId: "guild", channelId: "channel", messageId: id, authorId: event.authorId, timestampMs: event.timestampMs,
      representationHash: contextSourceHash(event), ...(projection ? { projection } : {}) };
  };
  const reply = (id: string, time: number, dependencies: readonly Dependency[]): void => {
    const content = `bot answer ${id}`;
    fixture.sources.set(id, { event: guardedEvent(id, time, content, "bot"), origin: "chat", provenance: { ...template, outputHash: hashContent(content), dependencies: [...dependencies] } });
  };
  return { fixture, revoked, store, dependency, reply };
}
const kept = (lease: GuardedConversationContext): string[] => lease.history.map((event) => event.messageId);
const cited = (lease: GuardedConversationContext): Dependency[] => lease.provenance("answer")?.dependencies ?? [];

describe("guarded context message revocations", () => {
  it.each(["stored", "refetch"] as const)("drops a deleted message and two generations of replies derived from it (%s proofs)", async (mode) => {
    const { fixture, revoked, dependency, reply } = await setup(mode);
    fixture.add(guardedEvent("deleted", 10_000, "something I regret"));
    fixture.add(guardedEvent("kept", 11_000, "something fine"));
    reply("reply-1", 20_000, [dependency("deleted")]);
    // The second generation cites the first reply and, flattened, the deleted message.
    reply("reply-2", 30_000, mode === "stored" ? [dependency("reply-1"), dependency("deleted")] : [dependency("reply-1")]);
    revoked.add("deleted");
    // The transport still returns the deleted message, as a cached snapshot would.
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease)).toEqual(["kept"]);
    expect(cited(lease).map((entry) => entry.messageId)).not.toContain("deleted");
  });

  it("drops a deleted bot reply even though bot-authored citations skip the per-author checks", async () => {
    const { fixture, revoked, dependency, reply } = await setup();
    fixture.add(guardedEvent("question", 10_000, "what is the plan?"));
    reply("reply-1", 20_000, [dependency("question")]);
    reply("reply-2", 30_000, [dependency("reply-1"), dependency("question")]);
    revoked.add("reply-1");
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease)).toEqual(["question"]);
  });

  it.each(["snapshot", "full"] as const)("rejects provider attempts and effects once a revocation commits after collection (%s validation)", async (validation) => {
    const { fixture, revoked, dependency, reply } = await setup();
    fixture.add(guardedEvent("deleted", 10_000, "something I regret"));
    reply("reply-1", 20_000, [dependency("deleted")]);
    // A snapshot adapter answers from its warm cache and never sees the delete itself.
    if (validation === "snapshot") fixture.port.snapshotCurrent = vi.fn(() => Promise.resolve(true));
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease)).toEqual(["deleted", "reply-1"]);
    expect(await lease.validate()).toBe(true);
    revoked.add("deleted");
    expect(await lease.validate()).toBe(false);
    expect(await lease.validate("effect")).toBe(false);
  });

  it("rejects an effect when only an inherited citation is revoked", async () => {
    const { fixture, revoked, dependency, reply } = await setup();
    fixture.add(guardedEvent("old", 1_000, "an old message outside the window"));
    reply("reply-1", 20_000, [dependency("old")]);
    fixture.sources.delete("old");
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease)).toEqual(["reply-1"]);
    revoked.add("old");
    expect(await lease.validate()).toBe(false);
  });

  it("keeps data built only from daily-summary text, but not a conversational use of the same message", async () => {
    const { fixture, revoked, dependency, reply } = await setup();
    fixture.add(guardedEvent("summarized", 1_000, "a message the daily summary read"));
    const background = dependency("summarized", { kind: "background_text", chars: 100 });
    reply("from-summary", 20_000, [background]);
    fixture.sources.delete("summarized");
    revoked.add("summarized");
    const onlyBackground = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(onlyBackground)).toEqual(["from-summary"]);
    expect(await onlyBackground.validate("effect")).toBe(true);

    // A reply that used the same message as conversation is revoked with it.
    fixture.add(guardedEvent("summarized", 1_000, "a message the daily summary read"));
    reply("from-chat", 25_000, [dependency("summarized")]);
    fixture.sources.delete("summarized");
    const mixed = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(mixed)).toEqual(["from-summary"]);
  });

  it("records the conversational use when one message reaches a turn through both projections", async () => {
    const { fixture, revoked, dependency, reply } = await setup();
    fixture.add(guardedEvent("both", 1_000, "summarized and quoted"));
    // History is admitted newest first, so the summary-only citation is carried before the conversational one.
    reply("from-chat", 20_000, [dependency("both")]);
    reply("from-summary", 25_000, [dependency("both", { kind: "background_text", chars: 100 })]);
    fixture.sources.delete("both");
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease)).toEqual(["from-chat", "from-summary"]);
    // The next reply's proof keeps the stricter, conversational entry, so its descendants stay revocable.
    expect(cited(lease).find((entry) => entry.messageId === "both")?.projection).toBeUndefined();
    revoked.add("both");
    expect(await lease.validate()).toBe(false);
  });

  it("fails closed when the revocation check itself fails", async () => {
    const { fixture, store } = await setup();
    fixture.add(guardedEvent("message", 10_000, "hello"));
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease)).toEqual(["message"]);
    store.failing = true;
    expect(await lease.validate()).toBe(false);
  });
});
