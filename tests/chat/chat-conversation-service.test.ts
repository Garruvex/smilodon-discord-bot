import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChatConversationService, type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { ExampleExchangeSelector } from "../../src/application/chat/example-exchange-selector.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine, MemoryRepository } from "../../src/application/memory/memory.js";
import type { EmbeddingsClient } from "../../src/infrastructure/chat/openai-embeddings-client.js";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";

function response(
  text: string,
  userMemoryActions: ChatResponse["userMemoryActions"] = [],
  guildKnowledgeCandidates: ChatResponse["guildKnowledgeCandidates"] = [],
  ambient: { action: ChatResponse["ambientAction"]; emoji?: string } | null = null,
): ChatResponse {
  return {
    text, userMemoryActions, guildKnowledgeCandidates, sources: [], usage: null, webSearchUsed: false,
    generatedImages: [], ambientAction: ambient?.action ?? null, reactionEmoji: ambient?.emoji ?? null,
  };
}

// Real engine + a real (temp-file) SQLite repository, rather than a hand-
// rolled store mock — exercises the actual channel-mode/scope/dedup logic
// this service now delegates to. `repository` is exposed so a test can seed
// pre-existing state directly (bypassing the candidate-review workflow),
// the same way the legacy tests seeded a store's loadConfirmed mock.
function testMemoryEngine(embeddingsClient?: EmbeddingsClient): { engine: MemoryEngine; repository: MemoryRepository } {
  const directory = mkdtempSync(join(tmpdir(), "chat-conversation-service-"));
  const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  return { engine: new DefaultMemoryEngine(repository, embeddingsClient ?? null), repository };
}

function input(message: string): ChatConversationInput {
  return {
    guildId: "guild",
    channelId: "channel",
    personality: "Friendly",
    examplePool: [],
    loreChunks: [],
    personaDrift: null,
    currentUser: { id: "user", displayName: "User", roleNames: [] },
    mentionedUsers: [],
    message,
    replyChain: [],
    channelHistory: [],
    images: [],
    webSearchMode: "off",
    imageGenerationEnabled: false,
    includeSources: false,
    triggerMode: "direct",
  };
}

function baseStore(overrides: Partial<ChatStateStore> = {}): ChatStateStore {
  return {
    initialize: () => Promise.resolve(),
    load: () => Promise.resolve({ exchanges: [], memories: [] }),
    commitSuccessfulExchange: () => Promise.resolve({ droppedExchanges: [] }),
    applyMemoryActions: () => Promise.resolve(),
    forgetMemory: () => Promise.resolve(false),
    forgetAllMemories: () => Promise.resolve(0),
    getDmNotesEnabled: () => Promise.resolve(true),
    setDmNotesEnabled: () => Promise.resolve(),
    ...overrides,
  };
}

describe("ChatConversationService", () => {
  it("delegates the dm-notes preference straight to the state store", async () => {
    const getDmNotesEnabled = vi.fn(() => Promise.resolve(false));
    const store = baseStore({ getDmNotesEnabled });
    const provider: ChatProvider = { reply: vi.fn(() => Promise.resolve(response("hello"))) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await expect(service.getDmNotesEnabled("guild", "user")).resolves.toBe(false);
    expect(getDmNotesEnabled).toHaveBeenCalledWith("guild", "user");
  });

  it("does not commit when Discord delivery fails", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const store = baseStore({ commitSuccessfulExchange });
    const provider: ChatProvider = { reply: vi.fn(() => Promise.resolve(response("hello"))) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await expect(service.run(input("hi"), () => Promise.reject(new Error("delivery failed"))))
      .rejects.toThrow("delivery failed");
    expect(commitSuccessfulExchange).not.toHaveBeenCalled();
  });

  it("persists the exact Discord-visible response returned by delivery", async () => {
    let storedAssistantMessage = "";
    const store = baseStore({
      commitSuccessfulExchange: (commit) => {
        storedAssistantMessage = commit.assistantMessage;
        return Promise.resolve({ droppedExchanges: [] });
      },
    });
    const provider: ChatProvider = { reply: () => Promise.resolve(response("raw provider response")) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await service.run(input("hi"), () => Promise.resolve("Discord-visible response with sources"));
    expect(storedAssistantMessage).toBe("Discord-visible response with sources");
  });

  it("serializes a user's messages so the second request sees the first exchange", async () => {
    const exchanges: Array<{ user: { content: string; createdAt: number }; assistant: { content: string; createdAt: number } }> = [];
    const seenHistoryLengths: number[] = [];
    const store = baseStore({
      load: () => Promise.resolve({ exchanges: [...exchanges], memories: [] }),
      commitSuccessfulExchange: (commit) => {
        exchanges.push({
          user: { content: commit.userMessage, createdAt: commit.now },
          assistant: { content: commit.assistantMessage, createdAt: commit.now },
        });
        return Promise.resolve({ droppedExchanges: [] });
      },
    });
    const provider: ChatProvider = {
      reply: (request: ChatRequest) => {
        seenHistoryLengths.push(request.recentHistory.length);
        return Promise.resolve(response(`reply ${request.message}`));
      },
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await Promise.all([
      service.run(input("one"), (reply) => Promise.resolve(reply.text)),
      service.run(input("two"), (reply) => Promise.resolve(reply.text)),
    ]);
    expect(seenHistoryLengths).toEqual([0, 2]);
  });

  it("discards actions with invented subjects, invalid topics, and secrets", async () => {
    const store = baseStore();
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [
        { action: "upsert", subjectUserId: "invented", topic: "preference", slot: "food", statement: "likes apples" },
        { action: "upsert", subjectUserId: "user", topic: "unknown", slot: "food", statement: "likes apples" },
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "api", statement: "api_key = secret-value-123" },
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ])),
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("remember this"), (reply) => Promise.resolve(reply.text));
    const stored = await engine.listUserMemories("guild", "user");
    expect(stored).toMatchObject([{ subjectId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
  });

  it("loads confirmed guild knowledge and submits validated candidates after delivery", async () => {
    const store = baseStore();
    let receivedKnowledgeCount = -1;
    const provider: ChatProvider = {
      reply: (request) => {
        receivedKnowledgeCount = request.guildKnowledge.length;
        return Promise.resolve(response("ok", [], [{
          subjectType: "member", subjectId: "user", topic: "event_responsibility",
          slot: "raid.friday", statement: "organizes Friday raids", channelScoped: false,
        }]));
      },
    };
    const { engine, repository } = testMemoryEngine();
    // Pre-existing confirmed guild knowledge — seeded directly on the
    // repository (bypassing the candidate/review workflow), same role the
    // legacy test's loadConfirmed mock played.
    await repository.ingest({
      guildId: "guild", kind: "fact", audience: "guild", ownerUserId: null, channelId: null,
      isolationChannelId: null, subjectType: "guild", subjectId: "guild", topic: "community", slot: "mascot",
      statement: "ExampleBot is the mascot", status: "active", source: "administrator", confidence: 1, importance: 1,
      embedding: null, embeddingModel: null, expiresAt: null, now: 0,
      sourceMessageId: null, sourceChannelId: null, assertedByUserId: null,
    });
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text));
    expect(receivedKnowledgeCount).toBe(1);
    // The proposed candidate is a member self-report, so it activates
    // immediately (resolveInitialStatus) and is recallable right away.
    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "user", message: "raid",
      recentHistory: [], subjectIds: ["user"], now: Date.now(),
    });
    expect(recalled.memories).toContainEqual(expect.objectContaining({ subjectId: "user", slot: "raid.friday" }));
  });

  it("embeds a proposed candidate's statement before persisting it, when an embeddings client is injected", async () => {
    const store = baseStore();
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [], [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", channelScoped: false,
      }])),
    };
    const embeddingsClient: EmbeddingsClient = {
      embed: (text: string): Promise<number[]> => Promise.resolve(text.length % 2 === 0 ? [1, 0] : [0, 1]),
    };
    const { engine } = testMemoryEngine(embeddingsClient);
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text));
    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "user", message: "raid",
      recentHistory: [], subjectIds: ["user"], now: Date.now(),
    });
    expect(recalled.memories[0]?.embedding).not.toBeNull();
  });

  it("degrades to a null embedding instead of failing the turn when the embed call rejects", async () => {
    const store = baseStore();
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [], [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", channelScoped: false,
      }])),
    };
    const embeddingsClient: EmbeddingsClient = {
      embed: (): Promise<number[]> => Promise.reject(new Error("embeddings provider down")),
    };
    const { engine } = testMemoryEngine(embeddingsClient);
    const service = new ChatConversationService(provider, store, engine);

    await expect(service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text)))
      .resolves.toBeDefined();
    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "user", message: "raid",
      recentHistory: [], subjectIds: ["user"], now: Date.now(),
    });
    expect(recalled.memories[0]?.embedding).toBeNull();
  });

  it("narrows the guild's example pool through the injected selector and threads the result into the request", async () => {
    const store = baseStore();
    const pool = [{ tags: "exam", user: "我今天期中考炸了", character: "草ww 哪科啦" }];
    const selected = [pool[0]!];
    let receivedRecords: typeof pool | null = null;
    let receivedExampleExchanges: typeof pool | null = null;
    const provider: ChatProvider = {
      reply: (request) => {
        receivedExampleExchanges = [...request.exampleExchanges];
        return Promise.resolve(response("ok"));
      },
    };
    const exampleExchangeSelector: ExampleExchangeSelector = {
      select: (selectInput): Promise<typeof pool> => {
        receivedRecords = [...selectInput.records];
        return Promise.resolve(selected);
      },
    };
    const service = new ChatConversationService(
      provider, store, testMemoryEngine().engine, undefined, exampleExchangeSelector, undefined,
    );

    await service.run({ ...input("hi"), examplePool: pool }, (reply) => Promise.resolve(reply.text));
    expect(receivedRecords).toEqual(pool);
    expect(receivedExampleExchanges).toEqual(selected);
  });

  it("loads per-user customization and reports it separately from the guild personality", async () => {
    const store = baseStore();
    const customizationStore: UserCustomizationStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve("Call me 阿龍."),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    let receivedCustomization: string | null = null;
    const provider: ChatProvider = {
      reply: (request: ChatRequest) => {
        receivedCustomization = request.userCustomization;
        return Promise.resolve(response("ok"));
      },
    };
    const service = new ChatConversationService(
      provider, store, testMemoryEngine().engine, undefined, undefined, undefined, customizationStore,
    );

    const result = await service.run(input("hi"), (reply) => Promise.resolve(reply.text));
    expect(receivedCustomization).toBe("Call me 阿龍.");
    expect(result.contextUsage).toMatchObject({ userCustomizationChars: "Call me 阿龍.".length });
  });

  it("defaults to no customization when no store is provided", async () => {
    const store = baseStore();
    let receivedCustomization: string | null = "not-null";
    const provider: ChatProvider = {
      reply: (request: ChatRequest) => {
        receivedCustomization = request.userCustomization;
        return Promise.resolve(response("ok"));
      },
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run(input("hi"), (reply) => Promise.resolve(reply.text));
    expect(receivedCustomization).toBeNull();
    expect(result.contextUsage).toMatchObject({ userCustomizationChars: 0 });
  });

  it("skips delivery and persistence entirely for an ambient turn the model chose to ignore", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const store = baseStore({ commitSuccessfulExchange });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("", [
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ], [], { action: "ignore" })),
    };
    const { engine } = testMemoryEngine();
    const ingestSpy = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn(() => Promise.resolve("should not be called"));

    const result = await service.run({ ...input("yohta is neat"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("ignore");
    expect(deliver).not.toHaveBeenCalled();
    expect(commitSuccessfulExchange).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("skips delivery and the session exchange, but still persists memory/guild-knowledge, for an ambient react-only turn", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const store = baseStore({ commitSuccessfulExchange });
    const memoryActions: ChatResponse["userMemoryActions"] = [
      { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ];
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("", memoryActions, [], { action: "ignore", emoji: "😂" })),
    };
    const { engine } = testMemoryEngine();
    const ingestSpy = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn(() => Promise.resolve("should not be called"));

    const result = await service.run({ ...input("yohta lol"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("ignore");
    expect(result.reactionEmoji).toBe("😂");
    expect(deliver).not.toHaveBeenCalled();
    expect(commitSuccessfulExchange).not.toHaveBeenCalled();
    expect(ingestSpy).toHaveBeenCalledOnce();
    const stored = await engine.listUserMemories("guild", "user");
    expect(stored).toMatchObject([{ statement: "likes green apples" }]);
  });

  it("delivers a reply and reacts in the same ambient turn when both are set", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const store = baseStore({ commitSuccessfulExchange });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("That's a good one!", [], [], { action: "reply", emoji: "😂" })),
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const result = await service.run({ ...input("yohta that's hilarious"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("reply");
    expect(result.reactionEmoji).toBe("😂");
    expect(deliver).toHaveBeenCalledOnce();
    expect(commitSuccessfulExchange).toHaveBeenCalledOnce();
  });

  it("delivers and persists an ambient turn the model chose to reply to, same as a direct turn", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const store = baseStore({ commitSuccessfulExchange });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("Hi there!", [], [], { action: "reply" })),
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const result = await service.run({ ...input("hey yohta, what's up"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("reply");
    expect(deliver).toHaveBeenCalledOnce();
    expect(commitSuccessfulExchange).toHaveBeenCalledOnce();
  });

  it("reports ambient channel history size in contextUsage", async () => {
    const store = baseStore();
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const channelHistory = [
      { authorId: "other", authorDisplayName: "Other", content: "earlier chatter", imageCount: 0 },
    ];

    const result = await service.run(
      { ...input("hi"), channelHistory },
      (reply) => Promise.resolve(reply.text),
    );
    expect(result.contextUsage).toMatchObject({
      channelHistoryMessages: 1,
      channelHistoryChars: JSON.stringify(channelHistory).length,
    });
  });

  it("consolidates dropped exchanges into channel-scoped guild knowledge when the provider supports it", async () => {
    const store = baseStore({
      commitSuccessfulExchange: () => Promise.resolve({
        droppedExchanges: [{ user: { content: "old question", createdAt: 0 }, assistant: { content: "old answer", createdAt: 0 } }],
      }),
    });
    const summarizeDroppedExchanges = vi.fn(() => Promise.resolve([
      { slot: "scene.discovery", statement: "the party found a hidden door", subjectType: "guild" as const },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), summarizeDroppedExchanges };
    const { engine } = testMemoryEngine();
    const ingestSpy = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("what happened earlier"), (reply) => Promise.resolve(reply.text));
    // Consolidation runs off the queue lock now (fire-and-forget after the
    // turn resolves — see chat-conversation-service.ts's run()), so it isn't
    // necessarily done yet when run() returns.
    await vi.waitFor(() => expect(summarizeDroppedExchanges).toHaveBeenCalled());
    expect(summarizeDroppedExchanges).toHaveBeenCalledWith(
      [{ user: "old question", assistant: "old answer" }],
      { id: "user", displayName: "User" },
    );
    // The turn itself proposes nothing (response("ok") has no candidates),
    // so only consolidation's ingest call happens.
    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());
    expect(ingestSpy).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild", channelId: "channel", assertedByUserId: "user", source: "consolidation",
      proposals: [expect.objectContaining({
        action: "upsert", subjectType: "guild", subjectId: "guild",
        topic: "scene_summary", slot: "scene.discovery", channelScoped: true,
      })],
    }));
  });

  it("condenses replyChainOverflow into replyChainSummary before asking the provider to reply", async () => {
    const store = baseStore();
    const summarizeReplyChainOverflow = vi.fn(() => Promise.resolve("Alice mentioned liking apples earlier."));
    const reply = vi.fn(() => Promise.resolve(response("ok")));
    const provider: ChatProvider = { reply, summarizeReplyChainOverflow };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await service.run({
      ...input("what did she say"),
      replyChainOverflow: [{ authorId: "authorA", authorDisplayName: "Alice", content: "I like apple", imageCount: 0 }],
    }, (r) => Promise.resolve(r.text));

    expect(summarizeReplyChainOverflow).toHaveBeenCalledWith([{ authorDisplayName: "Alice", content: "I like apple" }]);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ replyChainSummary: "Alice mentioned liking apples earlier." }),
      undefined,
    );
  });

  it("leaves replyChainSummary null when there's no overflow, without calling the summarizer", async () => {
    const store = baseStore();
    const summarizeReplyChainOverflow = vi.fn(() => Promise.resolve("should not be called"));
    const reply = vi.fn(() => Promise.resolve(response("ok")));
    const provider: ChatProvider = { reply, summarizeReplyChainOverflow };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await service.run(input("hi"), (r) => Promise.resolve(r.text));

    expect(summarizeReplyChainOverflow).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ replyChainSummary: null }), undefined);
  });

  it("continues without a reply-chain summary when the summarizer call fails", async () => {
    const store = baseStore();
    const summarizeReplyChainOverflow = vi.fn(() => Promise.reject(new Error("provider down")));
    const reply = vi.fn(() => Promise.resolve(response("ok")));
    const provider: ChatProvider = { reply, summarizeReplyChainOverflow };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await service.run({
      ...input("what did she say"),
      replyChainOverflow: [{ authorId: "authorA", authorDisplayName: "Alice", content: "I like apple", imageCount: 0 }],
    }, (r) => Promise.resolve(r.text));

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ replyChainSummary: null }), undefined);
  });

  it("keeps a guild-knowledge candidate about a reply-chain author, not just the current user or an @mention", async () => {
    const store = baseStore();
    const candidates: ChatResponse["guildKnowledgeCandidates"] = [
      {
        subjectType: "member", subjectId: "authorA", topic: "community_activity",
        slot: "fruit.orange", statement: "likes orange", channelScoped: false,
      },
    ];
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", [], candidates)) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run({
      ...input("i think he likes orange"),
      replyChain: [{ authorId: "authorA", authorDisplayName: "A", content: "i like apple", imageCount: 0 }],
    }, (reply) => Promise.resolve(reply.text));

    expect(result.guildKnowledgeCandidates).toEqual([
      expect.objectContaining({ subjectType: "member", subjectId: "authorA", statement: "likes orange" }),
    ]);
  });

  it("attributes a member-subject consolidation fact to the actual speaker, not the guild", async () => {
    const store = baseStore({
      commitSuccessfulExchange: () => Promise.resolve({
        droppedExchanges: [{ user: { content: "I'll take the Friday raid lead", createdAt: 0 }, assistant: { content: "Got it.", createdAt: 0 } }],
      }),
    });
    const summarizeDroppedExchanges = vi.fn(() => Promise.resolve([
      { slot: "raid.friday_lead", statement: "volunteered to lead Friday raids", subjectType: "member" as const },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), summarizeDroppedExchanges };
    const { engine } = testMemoryEngine();
    const ingestSpy = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("what happened earlier"), (reply) => Promise.resolve(reply.text));
    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());
    expect(ingestSpy).toHaveBeenCalledWith(expect.objectContaining({
      assertedByUserId: "user",
      proposals: [expect.objectContaining({
        action: "upsert", subjectType: "member", subjectId: "user",
        topic: "scene_summary", slot: "raid.friday_lead",
      })],
    }));
  });

  it("skips consolidation entirely when no exchanges were dropped", async () => {
    const store = baseStore();
    const summarizeDroppedExchanges = vi.fn(() => Promise.resolve([]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), summarizeDroppedExchanges };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await service.run(input("hi"), (reply) => Promise.resolve(reply.text));
    expect(summarizeDroppedExchanges).not.toHaveBeenCalled();
  });

  it("does not fail the turn when consolidation itself throws", async () => {
    const store = baseStore({
      commitSuccessfulExchange: () => Promise.resolve({
        droppedExchanges: [{ user: { content: "old question", createdAt: 0 }, assistant: { content: "old answer", createdAt: 0 } }],
      }),
    });
    const summarizeDroppedExchanges = vi.fn(() => Promise.reject(new Error("provider down")));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), summarizeDroppedExchanges };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await expect(service.run(input("hi"), (reply) => Promise.resolve(reply.text))).resolves.toBeDefined();
  });

  it("evolves persona drift after dropped exchanges when the guild has it enabled", async () => {
    const store = baseStore({
      commitSuccessfulExchange: () => Promise.resolve({
        droppedExchanges: [{ user: { content: "old question", createdAt: 0 }, assistant: { content: "old answer", createdAt: 0 } }],
      }),
    });
    const evolvePersonaDrift = vi.fn(() => Promise.resolve("A little more playful lately."));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), evolvePersonaDrift };
    const driftDirectory = mkdtempSync(join(tmpdir(), "chat-conversation-drift-"));
    const driftStore = new PersonaDriftStore(driftDirectory);
    const service = new ChatConversationService(
      provider, store, testMemoryEngine().engine, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, driftStore,
    );

    await service.run({ ...input("what happened earlier"), personaDriftEnabled: true }, (reply) => Promise.resolve(reply.text));

    // Consolidation runs off the queue lock now (fire-and-forget after the
    // turn resolves — see chat-conversation-service.ts's run()), so it isn't
    // necessarily done yet when run() returns.
    await vi.waitFor(() => expect(evolvePersonaDrift).toHaveBeenCalled());
    expect(evolvePersonaDrift).toHaveBeenCalledWith("", [{ user: "old question", assistant: "old answer" }]);
    await vi.waitFor(async () => {
      await expect(driftStore.get("guild")).resolves.toMatchObject({ text: "A little more playful lately." });
    });
    rmSync(driftDirectory, { recursive: true, force: true });
  });

  it("does not evolve persona drift when the guild has it disabled", async () => {
    const store = baseStore({
      commitSuccessfulExchange: () => Promise.resolve({
        droppedExchanges: [{ user: { content: "old question", createdAt: 0 }, assistant: { content: "old answer", createdAt: 0 } }],
      }),
    });
    const evolvePersonaDrift = vi.fn(() => Promise.resolve("A little more playful lately."));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), evolvePersonaDrift };
    const driftDirectory = mkdtempSync(join(tmpdir(), "chat-conversation-drift-"));
    const driftStore = new PersonaDriftStore(driftDirectory);
    const service = new ChatConversationService(
      provider, store, testMemoryEngine().engine, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, driftStore,
    );

    await service.run(input("what happened earlier"), (reply) => Promise.resolve(reply.text));

    expect(evolvePersonaDrift).not.toHaveBeenCalled();
    rmSync(driftDirectory, { recursive: true, force: true });
  });
});
