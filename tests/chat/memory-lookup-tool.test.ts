import { describe, expect, it } from "vitest";

import { MemoryLookupTool } from "../../src/application/chat/tools/memory-lookup-tool.js";
import type { Memory, MemoryEngine, MemoryRecallInput } from "../../src/application/memory/memory.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";

function fakeMemory(overrides: Partial<Memory>): Memory {
  return {
    id: "mem-1", guildId: "guild-1", kind: "fact", audience: "private", ownerUserId: "user-1",
    channelId: null, isolationChannelId: null, subjectType: "member", subjectId: "user-1",
    topic: "preference", slot: "food.fruit", statement: "likes apples", structuredValue: null,
    status: "active", supersededById: null, source: "live", confidence: 1, importance: 1,
    embedding: null, embeddingModel: null, createdAt: 0, updatedAt: 0, expiresAt: null,
    validFrom: 0, validUntil: null,
    ...overrides,
  };
}

function fakeContext(channelMode: ChatToolContext["channelMode"]): ChatToolContext {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    currentUser: { id: "user-1", displayName: "Tester", roleNames: [] },
    channelIsNsfw: false,
    channelMode,
    isOwner: false,
    music: null,
    pendingGeneratedImages: [],
  };
}

// recall() itself already enforces "disabled" (see memory-engine.test.ts) —
// this test only proves the tool actually forwards ctx.channelMode into the
// recall call, rather than silently bypassing it the way it did before this
// field existed.
describe("MemoryLookupTool", () => {
  it("forwards the turn's channelMode into memoryEngine.recall", async () => {
    let received: MemoryRecallInput | null = null;
    const memoryEngine: Partial<MemoryEngine> = {
      recall: (input) => {
        received = input;
        return Promise.resolve({ memories: [], causalChains: [] });
      },
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);
    await tool.execute({ query: "apples", scope: "search" }, fakeContext("disabled"));
    expect(received).not.toBeNull();
    expect(received!.channelMode).toBe("disabled");
  });

  it("requires a topical match in 'search' scope but not in 'list' scope", async () => {
    const received: MemoryRecallInput[] = [];
    const memoryEngine: Partial<MemoryEngine> = {
      recall: (input) => {
        received.push(input);
        return Promise.resolve({ memories: [], causalChains: [] });
      },
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);

    await tool.execute({ query: "favorite fruit", scope: "search" }, fakeContext("shared"));
    await tool.execute({ query: "", scope: "list" }, fakeContext("shared"));

    expect(received).toHaveLength(2);
    expect(received[0]!.requireTopicalMatch).toBe(true);
    expect(received[1]!.requireTopicalMatch).toBe(false);
  });

  it("rejects an empty query in 'search' scope but allows one in 'list' scope", async () => {
    const memoryEngine: Partial<MemoryEngine> = {
      recall: () => Promise.resolve({ memories: [], causalChains: [] }),
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);

    const searchResult = await tool.execute({ query: "  ", scope: "search" }, fakeContext("shared"));
    expect(searchResult.content).toBe("Empty search query.");

    const listResult = await tool.execute({ query: "", scope: "list" }, fakeContext("shared"));
    expect(listResult.content).not.toBe("Empty search query.");
  });

  it("'list' scope returns only the caller's own private memories, never guild knowledge about others", async () => {
    const memoryEngine: Partial<MemoryEngine> = {
      recall: () => Promise.resolve({
        memories: [
          fakeMemory({ audience: "private", subjectId: "user-1", statement: "likes green apples" }),
          // recall() only *boosts* guild/channel-audience results about the
          // current user, it doesn't filter the rest out — this fact is
          // about someone else entirely, and must never surface from a
          // broad "what do you remember about me" request.
          fakeMemory({ audience: "guild", subjectType: "member", subjectId: "bob", statement: "bob likes pizza" }),
        ],
        causalChains: [],
      }),
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);

    const result = await tool.execute({ query: "", scope: "list" }, fakeContext("shared"));

    const parsed = JSON.parse(result.content) as { userMemories: unknown[]; guildKnowledge: unknown[] };
    expect(parsed.userMemories).toEqual([{ topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
    expect(parsed.guildKnowledge).toEqual([]);
  });

  it("'list' scope asks recall() to narrow the candidate set itself (onlySelfPrivateMemories), not just filter the result", async () => {
    // The actual "owner+subject must both be the caller" filtering lives
    // inside DefaultMemoryEngine.recall now (see memory-engine.test.ts) —
    // applied to the candidate set before ranking/budgeting, not as a
    // post-hoc filter here. This only checks the tool asks for that.
    let received: MemoryRecallInput | null = null;
    const memoryEngine: Partial<MemoryEngine> = {
      recall: (input) => {
        received = input;
        return Promise.resolve({ memories: [], causalChains: [] });
      },
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);

    await tool.execute({ query: "", scope: "list" }, fakeContext("shared"));
    expect(received!.onlySelfPrivateMemories).toBe(true);

    await tool.execute({ query: "pizza", scope: "search" }, fakeContext("shared"));
    expect(received!.onlySelfPrivateMemories).toBe(false);
  });

  it("'list' scope returns more than 10 private memories when the caller has that many, matching its 'everything stored' description", async () => {
    // recall() bounds the result set by its own character budget
    // (maxSelectedChars), not by count — a fixed 10-item slice here would
    // silently drop real memories once a user has more than that, exactly
    // recreating the under-remembering perception this whole feature exists
    // to fix, even though the tool's own description promises "everything
    // stored". "search" scope still slices — see the next test.
    const manyMemories = Array.from({ length: 15 }, (_unused, i) =>
      fakeMemory({ audience: "private", subjectId: "user-1", slot: `fact.${i}`, statement: `fact number ${i}` }));
    const memoryEngine: Partial<MemoryEngine> = {
      recall: () => Promise.resolve({ memories: manyMemories, causalChains: [] }),
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);

    const result = await tool.execute({ query: "", scope: "list" }, fakeContext("shared"));

    const parsed = JSON.parse(result.content) as { userMemories: unknown[] };
    expect(parsed.userMemories).toHaveLength(15);
  });

  it("'search' scope still returns matching guild knowledge, unlike 'list'", async () => {
    const memoryEngine: Partial<MemoryEngine> = {
      recall: () => Promise.resolve({
        memories: [fakeMemory({ audience: "guild", subjectType: "member", subjectId: "bob", statement: "bob likes pizza" })],
        causalChains: [],
      }),
    };
    const tool = new MemoryLookupTool(memoryEngine as MemoryEngine);

    const result = await tool.execute({ query: "pizza", scope: "search" }, fakeContext("shared"));

    const parsed = JSON.parse(result.content) as { userMemories: unknown[]; guildKnowledge: unknown[] };
    expect(parsed.guildKnowledge).toEqual([{ topic: "preference", slot: "food.fruit", statement: "bob likes pizza" }]);
  });
});
