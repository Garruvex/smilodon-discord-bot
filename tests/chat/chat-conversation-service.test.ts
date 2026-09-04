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
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";
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
    purgeUser: () => Promise.resolve(),
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

  it("threads the originating Discord message id into a live memory write", async () => {
    const store = baseStore();
    const memoryActions: ChatResponse["userMemoryActions"] = [
      { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ];
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", memoryActions)) };
    const { engine } = testMemoryEngine();
    const ingestSpy = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService(provider, store, engine);

    await service.run({ ...input("remember this"), sourceMessageId: "msg-123" }, (reply) => Promise.resolve(reply.text));
    expect(ingestSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceMessageId: "msg-123" }));
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
      modelId: "test-model",
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
      modelId: "test-model",
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

  it("runs a dedicated post-reply extraction pass and ingests what it finds, even when the reply model itself returned no memory actions", async () => {
    const store = baseStore();
    const extractPersonalMemories = vi.fn(() => Promise.resolve([
      { action: "upsert" as const, aboutSpeaker: true, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ]));
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("Noted!")), // no userMemoryActions from the reply model
      extractPersonalMemories,
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run(input("I like green apples"), deliver);

    // The extraction+ingest pair is queued onto this user's own key (see
    // run()'s this.queue.run call) rather than started synchronously, so it
    // isn't done — or even called yet — by the time run() itself resolves.
    // Wait for both instead of asserting synchronously.
    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalledWith(
        "I like green apples", "Noted!", { id: "user", displayName: "User", roleNames: [] },
      );
    });
    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user");
      expect(stored).toMatchObject([{ statement: "likes green apples" }]);
    });
  });

  // This only proves the structural half of the defense: a candidate can
  // never land on Bob's OWN profile (subjectId "bob"), because the
  // extractor's return type has no subjectUserId field for the model to
  // set — every candidate is stamped with the speaker's id by construction,
  // regardless of what the model intended. It does NOT prove the model
  // can't mislabel a third-party fact as the speaker's own — a model that
  // (incorrectly) sets aboutSpeaker: true for "Bob likes green apples"
  // still gets written under the speaker here, same as this test asserts.
  // Preventing THAT is aboutSpeaker's job (the model's own explicit
  // self-check, enforced by dropping — not relabeling — anything false) —
  // see the next test, and its own residual-risk note.
  it("a candidate about a mentioned user is stamped with the speaker's id, never the mentioned user's — subjectUserId isn't a field the model controls", async () => {
    const store = baseStore();
    const extractPersonalMemories = vi.fn(() => Promise.resolve([
      { action: "upsert" as const, aboutSpeaker: true, sourceQuote: "Bob likes green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Noted!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run({ ...input("Bob likes green apples"), mentionedUsers: [{ id: "bob", displayName: "Bob", roleNames: [] }] }, deliver);

    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user");
      expect(stored).toMatchObject([{ subjectId: "user", statement: "likes green apples" }]);
    });
    // Never Bob's profile — that's the one thing this design guarantees
    // structurally. Whether it should have been written at all (it
    // shouldn't — the mock here incorrectly claims aboutSpeaker: true) is
    // a model-correctness question the next test covers, not this one.
    await expect(engine.listUserMemories("guild", "bob")).resolves.toHaveLength(0);
  });

  // A model that correctly recognizes "Bob likes pizza" isn't about the
  // speaker, per the prompt's subject rule — the app must respect
  // aboutSpeaker: false and drop this rather than writing it under the
  // speaker as though it were their own fact. This is the actual
  // misattribution defense (the previous test only covers the narrower,
  // structural "can't target Bob's own profile" guarantee) — and it's an
  // inherent, unclosed limit: it depends entirely on the model setting the
  // field correctly. A model that gets the judgment call wrong the other
  // way (aboutSpeaker: true for a fact that isn't) has no further app-side
  // check catching it, same residual risk any LLM-based self-check carries.
  it("drops (never force-relabels) an action the model itself flags as not about the speaker", async () => {
    const store = baseStore();
    const extractPersonalMemories = vi.fn(() => Promise.resolve([
      { action: "upsert" as const, aboutSpeaker: false, sourceQuote: "Bob likes pizza", topic: "preference", slot: "food.pizza", statement: "likes pizza" },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Noted!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run({ ...input("Bob likes pizza"), mentionedUsers: [{ id: "bob", displayName: "Bob", roleNames: [] }] }, deliver);

    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalled();
    });
    await expect(engine.listUserMemories("guild", "user")).resolves.toHaveLength(0);
    await expect(engine.listUserMemories("guild", "bob")).resolves.toHaveLength(0);
  });

  it("drops an action whose sourceQuote isn't actually in the user's message, even though aboutSpeaker is true — grounding, not just the model's self-check", async () => {
    const store = baseStore();
    // "you probably love jazz" is grounded in nothing the user actually
    // said — a sourceQuote that doesn't appear in the real message text
    // means the app can't verify it traces back to the user at all (see
    // personal-memory-extraction.ts's evidence rule).
    const extractPersonalMemories = vi.fn(() => Promise.resolve([
      { action: "upsert" as const, aboutSpeaker: true, sourceQuote: "you probably love jazz", topic: "preference", slot: "music.genre", statement: "loves jazz" },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Interesting!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run(input("hmm maybe"), deliver);

    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalled();
    });
    await expect(engine.listUserMemories("guild", "user")).resolves.toHaveLength(0);
  });

  it("keeps a slow background extraction from clobbering a later turn's correction — memory writes for one user stay ordered even though the reply doesn't wait for extraction", async () => {
    const store = baseStore();
    let resolveSlowExtraction!: (actions: readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]) => void;
    const slowExtraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]>((resolve) => {
      resolveSlowExtraction = resolve;
    });
    let replyCall = 0;
    const provider: ChatProvider = {
      reply: () => {
        replyCall += 1;
        // Turn 1 ("I like apples") relies entirely on the slow dedicated
        // extractor. Turn 2 ("actually I hate apples") is caught directly
        // by the reply model, the fast path.
        if (replyCall === 1) return Promise.resolve(response("Noted!"));
        return Promise.resolve(response("Got it!", [
          { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "hates apples" },
        ]));
      },
      extractPersonalMemories: () => slowExtraction,
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    // Turn 1's reply is delivered — extraction is still pending in the
    // background at this point.
    await service.run(input("I like apples"), deliver);
    // Turn 2 is queued behind turn 1's still-pending extraction (see
    // isBusy) rather than racing it.
    const turn2 = service.run(input("actually I hate apples"), deliver);
    // Only now does the slow extraction resolve, with the stale statement.
    resolveSlowExtraction([{ action: "upsert", aboutSpeaker: true, sourceQuote: "I like apples", topic: "preference", slot: "food.fruit", statement: "likes apples" }]);
    await turn2;

    // If extraction and turn 2 could race, "likes apples" landing after
    // "hates apples" would silently resurrect the stale fact. Serialized,
    // the correction always wins.
    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user");
      expect(stored).toMatchObject([{ statement: "hates apples" }]);
    });
  });

  it("reserves the extraction queue slot before delivery — a turn 2 arriving mid-commit still queues behind turn 1's extraction", async () => {
    // Reproduces the exact interleaving a post-delivery reservation would
    // miss: turn 2 is dispatched while turn 1 is still inside its own
    // callback (state-commit in progress, well before turn 1's run()
    // promise resolves) — the window where, if the extraction slot were
    // only reserved near the end of turn 1, turn 2 could capture turn 1's
    // own (still-open) queue tail and never end up ordered behind
    // extraction at all.
    let resolveCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { resolveCommit = resolve; });
    const commitSuccessfulExchange = vi.fn(async () => {
      await commitGate;
      return { droppedExchanges: [] };
    });
    const store = baseStore({ commitSuccessfulExchange });
    let resolveSlowExtraction!: (actions: readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]) => void;
    const slowExtraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]>((resolve) => {
      resolveSlowExtraction = resolve;
    });
    let replyCall = 0;
    const provider: ChatProvider = {
      reply: () => {
        replyCall += 1;
        if (replyCall === 1) return Promise.resolve(response("Noted!"));
        return Promise.resolve(response("Got it!", [
          { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "hates apples" },
        ]));
      },
      extractPersonalMemories: () => slowExtraction,
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const turn1 = service.run(input("I like apples"), deliver);
    // Turn 1 has been delivered and is now stalled inside commit — its own
    // run() promise has NOT resolved yet.
    await vi.waitFor(() => {
      expect(commitSuccessfulExchange).toHaveBeenCalled();
    });
    const turn2 = service.run(input("actually I hate apples"), deliver);
    resolveCommit();
    await turn1;
    resolveSlowExtraction([{ action: "upsert", aboutSpeaker: true, sourceQuote: "I like apples", topic: "preference", slot: "food.fruit", statement: "likes apples" }]);
    await turn2;

    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user");
      expect(stored).toMatchObject([{ statement: "hates apples" }]);
    });
  });

  it("does not run the dedicated extraction pass in a channel where durable writes are rejected anyway", async () => {
    const store = baseStore();
    const extractPersonalMemories = vi.fn(() => Promise.resolve([]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Noted!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run({ ...input("I like green apples"), channelMemoryModes: { channel: "disabled" } }, deliver);

    expect(extractPersonalMemories).not.toHaveBeenCalled();
  });

  it("swallows a dedicated-extraction failure instead of failing the turn", async () => {
    const store = baseStore();
    const extractPersonalMemories = vi.fn(() => Promise.reject(new Error("extractor down")));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Noted!")), extractPersonalMemories };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await expect(service.run(input("I like green apples"), deliver)).resolves.toMatchObject({ text: "Noted!" });
    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalledOnce();
    });
  });

  it("drain() waits for a pending background extraction instead of racing shutdown against it", async () => {
    const store = baseStore();
    let resolveExtraction!: () => void;
    const slowExtraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]>((resolve) => {
      resolveExtraction = (): void => resolve([
        { action: "upsert", aboutSpeaker: true, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ]);
    });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("Noted!")),
      extractPersonalMemories: () => slowExtraction,
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run(input("I like green apples"), deliver);
    // Reply already delivered — extraction is still pending in the
    // background. A shutdown right now (simulated by calling drain())
    // must not proceed until it's done.
    const drained = service.drain();
    let drainedYet = false;
    void drained.then(() => { drainedYet = true; });
    await Promise.resolve(); // let any already-settled microtasks flush
    expect(drainedYet).toBe(false);

    resolveExtraction();
    await drained;
    expect(drainedYet).toBe(true);
    const stored = await engine.listUserMemories("guild", "user");
    expect(stored).toMatchObject([{ statement: "likes green apples" }]);
  });

  it("drain() keeps waiting when a later background task is registered after its snapshot, before the first one settles", async () => {
    // Reproduces the exact race: the dedicated-extraction sub-task is
    // reserved (trackBackground'd) as the very first statement in run(),
    // before deliver() — but its underlying queue entry can't actually
    // start doing work until this whole turn's own callback returns (see
    // run()'s own comment on the reservation). Dropped-exchange
    // consolidation is only tracked later, near the end of the same turn,
    // after commit. So if drain() is called while the turn is still
    // in-flight — after the reservation, before commit — its first
    // snapshot sees only the extraction entry. A one-shot
    // Promise.allSettled([...pendingBackgroundWork]) captured at that
    // moment would resolve as soon as extraction alone settles, even
    // though consolidation (registered afterward, still pending) hasn't.
    let resolveExtraction!: (value: readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]) => void;
    const extraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string }[]>((resolve) => {
      resolveExtraction = resolve;
    });
    let resolveCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { resolveCommit = resolve; });
    let resolveConsolidation!: () => void;
    const consolidationGate = new Promise<void>((resolve) => { resolveConsolidation = resolve; });
    const extractPersonalMemories = vi.fn(() => extraction);
    const summarizeDroppedExchanges = vi.fn(() => consolidationGate.then(() => []));
    const commitSuccessfulExchange = vi.fn(async () => {
      await commitGate;
      return { droppedExchanges: [{ user: { content: "hi", createdAt: 0 }, assistant: { content: "hello", createdAt: 0 } }] };
    });
    const store = baseStore({ commitSuccessfulExchange });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("Noted!")),
      extractPersonalMemories,
      summarizeDroppedExchanges,
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const run = service.run(input("I like green apples"), deliver);
    // The extraction reservation happens before deliver() — wait for
    // deliver() itself to confirm we're mid-turn, past the reservation,
    // with commit (and therefore consolidation, tracked after it) still
    // gated.
    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalled();
    });

    const drained = service.drain();
    let drainedYet = false;
    void drained.then(() => { drainedYet = true; });
    await Promise.resolve();

    // Let commit proceed now that drain's first snapshot has already been
    // taken — this registers the consolidation background task afterward,
    // and lets the turn's own run() promise (and therefore the extraction
    // queue entry) actually resolve/start.
    resolveCommit();
    await run;
    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalled();
    });
    expect(summarizeDroppedExchanges).toHaveBeenCalled();

    // Settle the one piece of work drain's first snapshot actually knew
    // about. A single-snapshot drain() would resolve here even though
    // consolidation (registered after the snapshot) is still pending. Real
    // timers (not just microtask flushes) give the extraction promise's own
    // chain — task() completion, the queue's release/cleanup, the real
    // SQLite-backed ingest call inside extractAndIngestPersonalMemories —
    // room to fully settle, so this genuinely distinguishes "still waiting
    // on consolidation" from "just hasn't flushed yet".
    resolveExtraction([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drainedYet).toBe(false);

    resolveConsolidation();
    await drained;
    expect(drainedYet).toBe(true);
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

  it("does not evolve the guild-wide persona drift from an isolated channel's dropped exchanges", async () => {
    const store = baseStore({
      commitSuccessfulExchange: () => Promise.resolve({
        droppedExchanges: [{ user: { content: "secret channel stuff", createdAt: 0 }, assistant: { content: "noted", createdAt: 0 } }],
      }),
    });
    const evolvePersonaDrift = vi.fn(() => Promise.resolve("Leaked from the isolated channel."));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")), evolvePersonaDrift };
    const driftDirectory = mkdtempSync(join(tmpdir(), "chat-conversation-drift-"));
    const driftStore = new PersonaDriftStore(driftDirectory);
    const service = new ChatConversationService(
      provider, store, testMemoryEngine().engine, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, driftStore,
    );

    await service.run({
      ...input("what happened earlier"),
      personaDriftEnabled: true,
      channelMemoryModes: { channel: "isolated" },
    }, (reply) => Promise.resolve(reply.text));

    // Give the fire-and-forget consolidation a turn to run, then assert it
    // never touched the guild-wide drift overlay from this isolated channel.
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(evolvePersonaDrift).not.toHaveBeenCalled();
    await expect(driftStore.get("guild")).resolves.toBeNull();
    rmSync(driftDirectory, { recursive: true, force: true });
  });

  it("pins evolved persona drift to personalitySourceHash, not a hash of the compiled personality core", async () => {
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

    await service.run({
      ...input("what happened earlier"),
      personaDriftEnabled: true,
      // Simulates a compiled bundle: `personality` is only the always-sent
      // core, but the full uploaded file (lore included) hashes differently
      // — evolveFrom must be pinned to that full-file hash, not
      // hashContent("Friendly").
      personalitySourceHash: "full-file-hash-including-lore",
    }, (reply) => Promise.resolve(reply.text));

    await vi.waitFor(async () => {
      await expect(driftStore.get("guild")).resolves.toMatchObject({ personalitySourceHash: "full-file-hash-including-lore" });
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
