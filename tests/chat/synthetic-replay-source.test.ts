import { describe, expect, it } from "vitest";
import { syntheticReplaySource, syntheticReplayConfiguration } from "../../src/application/chat/synthetic-replay-context.js";
import { GuardedConversationContext, type GuardedContextSource } from "../../src/application/chat/guarded-conversation-context.js";
import { guardedEvent } from "../helpers/guarded-context-fixture.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";

describe("common conversation replay sources", () => {
  it("retains actual generated-reply proof without admitting another channel or an unproven bot", async () => {
    const first = guardedEvent("first", 1000, "first question");
    const sources = new Map<string, GuardedContextSource>([[first.messageId, { event: first, origin: "human", provenance: null }]]);
    const original = await GuardedConversationContext.open(syntheticReplaySource({ guildId: "guild", channelId: "channel", sourceMessageId: first.messageId, actorId: "alice" }, sources), { count: 40, budget: 12000, burstIds: [] });
    const reply = guardedEvent("reply", 2000, "actual generated reply", "bot", { replyToMessageId: first.messageId, replyToAuthorId: "alice" });
    sources.set(reply.messageId, { event: reply, origin: "chat", sourceMessageId: first.messageId, provenance: original.provenance(reply.content) });
    const forged = guardedEvent("unproven", 2500, "PRIVATE_UNPROVEN_BOT", "bot");
    sources.set(forged.messageId, { event: forged, origin: "chat", provenance: null });
    const hidden = guardedEvent("hidden", 2600, "PRIVATE_OTHER_CHANNEL", "alice", { channelId: "another" });
    sources.set(hidden.messageId, { event: hidden, origin: "human", provenance: null });
    const current = guardedEvent("current", 3000, "followup"); sources.set(current.messageId, { event: current, origin: "human", provenance: null });
    const port = syntheticReplaySource({ guildId: "guild", channelId: "channel", sourceMessageId: current.messageId, actorId: "alice" }, sources);
    const lease = await GuardedConversationContext.open(port, { count: 40, budget: 12000, burstIds: [] });
    expect(lease.history.map((event) => event.messageId)).toEqual(["first", "reply"]);
    expect(JSON.stringify(lease.history)).not.toContain("PRIVATE_"); expect(await port.read("hidden", new AbortController().signal)).toBeNull();
    sources.delete("first"); expect(await lease.validate()).toBe(false);
  });
  it.each(["session_only", "disabled", "isolated", "shared"] as const)("inherits the %s retention premise", async (mode) => {
    const event = guardedEvent("current", 1000, "hi"); const sources = new Map<string, GuardedContextSource>([[event.messageId, { event, origin: "human", provenance: null }]]);
    const lease = await GuardedConversationContext.open(syntheticReplaySource({ guildId: "guild", channelId: "channel", sourceMessageId: event.messageId, actorId: "alice" }, sources, mode), { count: 0, budget: 0, burstIds: [] });
    expect(lease.durableWritesAllowed).toBe(mode === "shared" || mode === "isolated"); expect(lease.sharedMemoryAllowed).toBe(mode === "shared");
  });
  it("rejects persona changes after a replay starts", async () => {
    let unchanged = true; const persona = await syntheticReplayConfiguration("guild", "authored persona", () => unchanged);
    await persona.check(); unchanged = false; await expect(persona.check()).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
});
