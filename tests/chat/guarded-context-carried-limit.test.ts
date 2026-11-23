import { describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { contextProvenanceLimits } from "../../src/application/chat/context-provenance.js";
import { hashContent } from "../../src/application/assets/content-hash.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { suppressionSite } from "../../src/application/diagnostics/chat-diagnostics.js";

const policy = { count: 40, budget: 12000, burstIds: [] };

// Production 2026-11-23: in a channel where the bot had been chatting, direct mentions were
// suppressed before the model was called. Earlier bot replies carry the messages their proofs
// cite; history kept adding evidence after that, so evidence + carried passed the proof limit
// and the turn could no longer build any provenance.
describe("guarded context carried-dependency limit", () => {
  it.each([["newer", 50_000], ["older", 5_000]])("still builds a proof when history holds %s bot replies whose proofs cite many messages", async (_label, botTime) => {
    const fixture = guardedFixture(guardedEvent("current", 100_000, "<@bot> hi"));
    fixture.port.sourcesAllowed = vi.fn((sources: readonly unknown[]) => Promise.resolve(sources.map(() => true)));
    const template = (await GuardedConversationContext.open(fixture.port, policy)).provenance("template")!;
    expect(template).not.toBeNull();

    // Older human chatter.
    for (let index = 0; index < 30; index++) fixture.add(guardedEvent(`human-${index}`, 10_000 + index, `message ${index}`));
    // The bot's recent replies, each citing 30 older messages that are not in the window.
    for (let reply = 0; reply < 4; reply++) {
      const content = `bot answer ${reply}`;
      const dependencies = Array.from({ length: 30 }, (_unused, index) => ({ guildId: "guild", channelId: "channel",
        messageId: `cited-${reply}-${index}`, authorId: "alice", timestampMs: 1_000 + reply * 100 + index,
        representationHash: hashContent(`cited-${reply}-${index}`) }));
      fixture.sources.set(`bot-${reply}`, { event: guardedEvent(`bot-${reply}`, botTime + reply, content, "bot"), origin: "chat",
        provenance: { ...template, outputHash: hashContent(content), dependencies } });
    }

    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(lease.history.some((event) => event.authorId === "bot")).toBe(true);
    const proof = lease.provenance("answer");    expect(proof).not.toBeNull();
    expect(proof!.dependencies.length).toBeLessThanOrEqual(contextProvenanceLimits.dependencies);
    expect(lease.provenance("operation:recall_embedding", "memory_claim")).not.toBeNull();
  });

  it("names the line that threw a suppression for the addressed-turn diagnostic", () => {
    const thrown = (): never => { throw new SocialOutputSuppressed(); };
    let site: string | undefined;
    try { thrown(); } catch (error) { site = suppressionSite(error); }
    expect(site).toMatch(/^guarded-context-carried-limit\.test\.ts:\d+$/u);
    expect(suppressionSite("not an error")).toBeUndefined();
  });
});
