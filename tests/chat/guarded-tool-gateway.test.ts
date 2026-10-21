import { describe, expect, it, vi } from "vitest";
import { guardedTools, resolveGuardedToolResource } from "../../src/application/chat/guarded-tool-gateway.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import { DiceRollTool } from "../../src/application/chat/tools/dice-tool.js";
import { ReadLinkTool } from "../../src/application/chat/tools/read-link-tool.js";
import { MemoryLookupTool } from "../../src/application/chat/tools/memory-lookup-tool.js";
import { BirthdayLookupTool } from "../../src/application/chat/tools/birthday-lookup-tool.js";
import type { ChatTool, ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import type { MemoryEngine, MemoryRecallInput, MemoryContext } from "../../src/application/memory/memory.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

async function setup(tools: ChatTool[] = [new DiceRollTool()]): Promise<{
  fixture: ReturnType<typeof guardedFixture>; lease: GuardedConversationContext; enabled: ChatTool[]; context: ChatToolContext; executed: ReturnType<typeof vi.fn>;
}> {
  const fixture = guardedFixture(guardedEvent("current", 4000, "read https://example.com/page"));
  const lease = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 4000, burstIds: [] });
  const check = async (): Promise<void> => { if (!await lease.validate()) throw new SocialOutputSuppressed(); };
  const executed = vi.fn();
  const enabled = guardedTools(new ChatToolRegistry(tools), lease, { enabled: true, guildId: "guild", channelId: "channel", userId: "alice" }, check, executed);
  const context: ChatToolContext = { guildId: "guild", channelId: "channel", currentUser: fixture.actors.get("alice")!,
    channelMode: "shared", channelIsNsfw: false, isOwner: false, music: null, pendingGeneratedImages: [] };
  return { fixture, lease, enabled, context, executed };
}

describe("guarded tool source boundary", () => {
  it("rejects unreviewed implementations even when their names imitate known tools", async () => {
    const { lease } = await setup();
    const fake = { ...new DiceRollTool(), execute: vi.fn() };
    expect(guardedTools(new ChatToolRegistry([fake]), lease, { enabled: true, guildId: "guild", channelId: "channel", userId: "alice" }, vi.fn(), vi.fn())).toEqual([]);
  });

  it("executes reviewed tools and rejects revoked or mismatched scope before execution", async () => {
    const { enabled, fixture, context, executed } = await setup();
    await enabled[0]!.execute({ count: 1, sides: 6 }, context);
    expect(executed).toHaveBeenCalledOnce();
    await expect(enabled[0]!.execute({}, { ...context, guildId: "elsewhere" })).rejects.toBeInstanceOf(SocialOutputSuppressed);
    fixture.denied.add("current");
    await expect(enabled[0]!.execute({}, context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(executed).toHaveBeenCalledOnce();
  });

  it("discards a result when a source changes during execution", async () => {
    const tool = new DiceRollTool(); const { enabled, fixture, context } = await setup([tool]);
    vi.spyOn(tool, "execute").mockImplementation(() => { fixture.denied.add("current"); return Promise.resolve({ content: "STALE_RESULT" }); });
    await expect(enabled[0]!.execute({}, context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });

  it("does not fetch invented links, and retains public fetched-result lineage", async () => {
    const tool = new ReadLinkTool(); const { enabled, context, lease } = await setup([tool]);
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ content: "PUBLIC_RESULT" });
    expect((await enabled[0]!.execute({ url: "https://other.example/private" }, context)).content).toContain("supplied authorized");
    expect(execute).not.toHaveBeenCalled();
    await enabled[0]!.execute({ url: "https://example.com/page" }, context);
    expect(lease.provenance("answer")?.publicTools?.[0]?.name).toBe("read_link");
    expect(lease.provenance("answer")?.publicTools?.[0]?.outputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("passes the registered lease into memory lookup and independently filters returned rows", async () => {
    const recall = vi.fn<(input: MemoryRecallInput) => Promise<MemoryContext>>().mockResolvedValue({ memories: [{ id: "legacy", statement: "HIDDEN_LEGACY" }] as never, causalChains: [] });
    const tool = new MemoryLookupTool({ recall } as unknown as MemoryEngine);
    const { enabled, context, lease } = await setup([tool]);
    const result = await enabled[0]!.execute({ query: "apples", scope: "search" }, context);
    expect(recall.mock.calls[0]![0].context).toBe(lease);
    expect(result.content).not.toContain("HIDDEN_LEGACY");
  });

  it.each(["edit", "revoke"] as const)("invalidates persisted birthday output on %s", async (change) => {
    const fixture = guardedFixture(); let month = 10;
    fixture.port.resource = (): Promise<string> => Promise.resolve(JSON.stringify({ month, day: 21 }));
    const lease = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 4000, burstIds: [] });
    expect(await lease.resource({ kind: "birthday", id: "alice" })).not.toBeNull();
    const proof = lease.provenance("birthday answer")!;
    expect(proof.resources).toHaveLength(1);
    fixture.sources.set("bot-answer", { event: guardedEvent("bot-answer", 4100, "birthday answer", "bot"), origin: "chat", provenance: proof });
    fixture.add(guardedEvent("next", 4200, "what birthday?", "alice", { replyToMessageId: "bot-answer" }));
    fixture.port.sourceMessageId = "next";
    if (change === "edit") month = 11; else fixture.actors.delete("alice");
    const next = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 4000, burstIds: [] });
    expect(next.replyChain).toEqual([]);
    expect(await lease.validate()).toBe(false);
  });

  it("resolves only registered birthday sources and supplied eligible subjects", async () => {
    const { context, fixture, lease } = await setup();
    const getBirthday = vi.fn().mockResolvedValue({ month: 10, day: 21, birthYear: 2000 });
    const tool = new BirthdayLookupTool({ getBirthday } as never, { find: (): unknown => ({ features: { birthdays: true }, timezone: "Asia/Taipei" }) } as never);
    const registry = new ChatToolRegistry([tool]);
    fixture.port.resource = (key, signal): Promise<string | null> => resolveGuardedToolResource(registry, key, { ...context, signal });
    expect((await tool.execute({ userId: "unknown" }, { ...context, contextLease: lease })).content).toContain("supplied authorized");
    expect(getBirthday).not.toHaveBeenCalled();
    const result = await tool.execute({ userId: "alice" }, { ...context, contextLease: lease });
    expect(result.content).toContain('"month":10');
    expect(lease.provenance("birthday")?.resources).toHaveLength(1);
  });
});
