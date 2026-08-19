import { describe, expect, it, vi } from "vitest";

import { ChatConversationService, type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { GuildKnowledgeStore } from "../../src/application/chat/guild-knowledge-store.js";
import type { GuildMemorySelector } from "../../src/application/chat/guild-memory-selector.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";

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

function guildStore(): GuildKnowledgeStore {
  return {
    initialize: () => Promise.resolve(),
    loadConfirmed: () => Promise.resolve([]),
    propose: () => Promise.resolve(),
  };
}

function input(message: string): ChatConversationInput {
  return {
    guildId: "guild",
    personality: "Friendly",
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

describe("ChatConversationService", () => {
  it("delegates the dm-notes preference straight to the state store", async () => {
    const getDmNotesEnabled = vi.fn(() => Promise.resolve(false));
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled,
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = { reply: vi.fn(() => Promise.resolve(response("hello"))) };
    const service = new ChatConversationService(provider, store, guildStore());

    await expect(service.getDmNotesEnabled("guild", "user")).resolves.toBe(false);
    expect(getDmNotesEnabled).toHaveBeenCalledWith("guild", "user");
  });

  it("does not commit when Discord delivery fails", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve());
    const store: ChatStateStore = {
      initialize: vi.fn(() => Promise.resolve()),
      load: vi.fn(() => Promise.resolve({ exchanges: [], memories: [] })),
      commitSuccessfulExchange,
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: vi.fn(() => Promise.resolve(false)),
      forgetAllMemories: vi.fn(() => Promise.resolve(0)),
      getDmNotesEnabled: vi.fn(() => Promise.resolve(true)),
      setDmNotesEnabled: vi.fn(() => Promise.resolve()),
    };
    const provider: ChatProvider = { reply: vi.fn(() => Promise.resolve(response("hello"))) };
    const service = new ChatConversationService(provider, store, guildStore());

    await expect(service.run(input("hi"), () => Promise.reject(new Error("delivery failed"))))
      .rejects.toThrow("delivery failed");
    expect(commitSuccessfulExchange).not.toHaveBeenCalled();
  });

  it("persists the exact Discord-visible response returned by delivery", async () => {
    let storedAssistantMessage = "";
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: (commit) => {
        storedAssistantMessage = commit.assistantMessage;
        return Promise.resolve();
      },
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = { reply: () => Promise.resolve(response("raw provider response")) };
    const service = new ChatConversationService(provider, store, guildStore());

    await service.run(input("hi"), () => Promise.resolve("Discord-visible response with sources"));
    expect(storedAssistantMessage).toBe("Discord-visible response with sources");
  });

  it("serializes a user's messages so the second request sees the first exchange", async () => {
    const exchanges: Array<{ user: { content: string; createdAt: number }; assistant: { content: string; createdAt: number } }> = [];
    const seenHistoryLengths: number[] = [];
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [...exchanges], memories: [] }),
      commitSuccessfulExchange: (commit) => {
        exchanges.push({
          user: { content: commit.userMessage, createdAt: commit.now },
          assistant: { content: commit.assistantMessage, createdAt: commit.now },
        });
        return Promise.resolve();
      },
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = {
      reply: (request: ChatRequest) => {
        seenHistoryLengths.push(request.recentHistory.length);
        return Promise.resolve(response(`reply ${request.message}`));
      },
    };
    const service = new ChatConversationService(provider, store, guildStore());

    await Promise.all([
      service.run(input("one"), (reply) => Promise.resolve(reply.text)),
      service.run(input("two"), (reply) => Promise.resolve(reply.text)),
    ]);
    expect(seenHistoryLengths).toEqual([0, 2]);
  });

  it("discards actions with invented subjects, invalid topics, and secrets", async () => {
    const committedActions: ChatResponse["userMemoryActions"][] = [];
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: (commit) => {
        committedActions.push(commit.actions);
        return Promise.resolve();
      },
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [
        { action: "upsert", subjectUserId: "invented", topic: "preference", slot: "food", statement: "likes apples" },
        { action: "upsert", subjectUserId: "user", topic: "unknown", slot: "food", statement: "likes apples" },
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "api", statement: "api_key = secret-value-123" },
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ])),
    };
    const service = new ChatConversationService(provider, store, guildStore());

    await service.run(input("remember this"), (reply) => Promise.resolve(reply.text));
    expect(committedActions[0]).toEqual([
      { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ]);
  });

  it("loads confirmed guild knowledge and submits validated candidates after delivery", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    let receivedKnowledgeCount = -1;
    const provider: ChatProvider = {
      reply: (request) => {
        receivedKnowledgeCount = request.guildKnowledge.length;
        return Promise.resolve(response("ok", [], [{
          subjectType: "member", subjectId: "user", topic: "event_responsibility",
          slot: "raid.friday", statement: "organizes Friday raids",
        }]));
      },
    };
    const proposals: Array<Parameters<GuildKnowledgeStore["propose"]>[0]> = [];
    const knowledgeStore: GuildKnowledgeStore = {
      initialize: () => Promise.resolve(),
      loadConfirmed: () => Promise.resolve([{
        id: "known", subjectType: "guild", subjectId: "guild", topic: "community",
        slot: "mascot", statement: "Pinecone is the mascot", source: "administrator", updatedAt: 0, embedding: null,
      }]),
      propose: (proposal) => { proposals.push(proposal); return Promise.resolve(); },
    };
    const service = new ChatConversationService(provider, store, knowledgeStore);

    await service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text));
    expect(receivedKnowledgeCount).toBe(1);
    expect(proposals[0]?.candidates).toMatchObject([{ subjectId: "user", slot: "raid.friday" }]);
  });

  it("embeds a proposed candidate's statement before persisting it, when an embeddings client is injected", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [], [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids",
      }])),
    };
    const proposals: Array<Parameters<GuildKnowledgeStore["propose"]>[0]> = [];
    const knowledgeStore: GuildKnowledgeStore = {
      initialize: () => Promise.resolve(),
      loadConfirmed: () => Promise.resolve([]),
      propose: (proposal) => { proposals.push(proposal); return Promise.resolve(); },
    };
    const embeddingsClient = {
      embed: (text: string): Promise<number[]> => Promise.resolve(text.length % 2 === 0 ? [1, 0] : [0, 1]),
    };
    const service = new ChatConversationService(
      provider, store, knowledgeStore, undefined, undefined, undefined, undefined, undefined, undefined,
      embeddingsClient,
    );

    await service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text));
    expect(proposals[0]?.candidates[0]?.embedding).not.toBeNull();
  });

  it("degrades to a null embedding instead of failing the turn when the embed call rejects", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [], [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids",
      }])),
    };
    const proposals: Array<Parameters<GuildKnowledgeStore["propose"]>[0]> = [];
    const knowledgeStore: GuildKnowledgeStore = {
      initialize: () => Promise.resolve(),
      loadConfirmed: () => Promise.resolve([]),
      propose: (proposal) => { proposals.push(proposal); return Promise.resolve(); },
    };
    const embeddingsClient = {
      embed: (): Promise<number[]> => Promise.reject(new Error("embeddings provider down")),
    };
    const service = new ChatConversationService(
      provider, store, knowledgeStore, undefined, undefined, undefined, undefined, undefined, undefined,
      embeddingsClient,
    );

    await expect(service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text)))
      .resolves.toBeDefined();
    expect(proposals[0]?.candidates[0]?.embedding).toBeNull();
  });

  it("uses a replaceable guild-memory selector and reports selected context size", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const known = {
      id: "known", subjectType: "guild" as const, subjectId: "guild", topic: "community",
      slot: "mascot", statement: "Pinecone is the mascot", source: "administrator" as const, updatedAt: 0,
      embedding: null,
    };
    const knowledgeStore: GuildKnowledgeStore = {
      initialize: () => Promise.resolve(),
      loadConfirmed: () => Promise.resolve([known]),
      propose: () => Promise.resolve(),
    };
    let providerRecordCount = -1;
    const provider: ChatProvider = {
      reply: (request) => {
        providerRecordCount = request.guildKnowledge.length;
        return Promise.resolve(response("ok"));
      },
    };
    const selector: GuildMemorySelector = {
      select: (): Promise<readonly never[]> => Promise.resolve([]),
    };
    const service = new ChatConversationService(provider, store, knowledgeStore, selector);

    const result = await service.run(input("hello"), (reply) => Promise.resolve(reply.text));
    expect(providerRecordCount).toBe(0);
    expect(result.contextUsage).toMatchObject({
      historyMessages: 0,
      guildKnowledgeRecords: 0,
      guildKnowledgeChars: 2,
    });
  });

  it("loads per-user customization and reports it separately from the guild personality", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
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
      provider,
      store,
      guildStore(),
      undefined,
      undefined,
      customizationStore,
    );

    const result = await service.run(input("hi"), (reply) => Promise.resolve(reply.text));
    expect(receivedCustomization).toBe("Call me 阿龍.");
    expect(result.contextUsage).toMatchObject({ userCustomizationChars: "Call me 阿龍.".length });
  });

  it("defaults to no customization when no store is provided", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    let receivedCustomization: string | null = "not-null";
    const provider: ChatProvider = {
      reply: (request: ChatRequest) => {
        receivedCustomization = request.userCustomization;
        return Promise.resolve(response("ok"));
      },
    };
    const service = new ChatConversationService(provider, store, guildStore());

    const result = await service.run(input("hi"), (reply) => Promise.resolve(reply.text));
    expect(receivedCustomization).toBeNull();
    expect(result.contextUsage).toMatchObject({ userCustomizationChars: 0 });
  });

  it("skips delivery and persistence entirely for an ambient turn the model chose to ignore", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve());
    const applyMemoryActions = vi.fn(() => Promise.resolve());
    const propose = vi.fn(() => Promise.resolve());
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange,
      applyMemoryActions,
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const knowledgeStore: GuildKnowledgeStore = { initialize: () => Promise.resolve(), loadConfirmed: () => Promise.resolve([]), propose };
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("", [
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ], [], { action: "ignore" })),
    };
    const service = new ChatConversationService(provider, store, knowledgeStore);
    const deliver = vi.fn(() => Promise.resolve("should not be called"));

    const result = await service.run({ ...input("yohta is neat"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("ignore");
    expect(deliver).not.toHaveBeenCalled();
    expect(commitSuccessfulExchange).not.toHaveBeenCalled();
    expect(applyMemoryActions).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
  });

  it("skips delivery and the session exchange, but still persists memory/guild-knowledge, for an ambient react-only turn", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve());
    const applyMemoryActions = vi.fn(() => Promise.resolve());
    const propose = vi.fn(() => Promise.resolve());
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange,
      applyMemoryActions,
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const knowledgeStore: GuildKnowledgeStore = { initialize: () => Promise.resolve(), loadConfirmed: () => Promise.resolve([]), propose };
    const memoryActions: ChatResponse["userMemoryActions"] = [
      { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ];
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("", memoryActions, [], { action: "ignore", emoji: "😂" })),
    };
    const service = new ChatConversationService(provider, store, knowledgeStore);
    const deliver = vi.fn(() => Promise.resolve("should not be called"));

    const result = await service.run({ ...input("yohta lol"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("ignore");
    expect(result.reactionEmoji).toBe("😂");
    expect(deliver).not.toHaveBeenCalled();
    expect(commitSuccessfulExchange).not.toHaveBeenCalled();
    expect(applyMemoryActions).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild", userId: "user", actions: memoryActions,
    }));
    expect(propose).toHaveBeenCalledOnce();
  });

  it("delivers a reply and reacts in the same ambient turn when both are set", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve());
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange,
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("That's a good one!", [], [], { action: "reply", emoji: "😂" })),
    };
    const service = new ChatConversationService(provider, store, guildStore());
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const result = await service.run({ ...input("yohta that's hilarious"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("reply");
    expect(result.reactionEmoji).toBe("😂");
    expect(deliver).toHaveBeenCalledOnce();
    expect(commitSuccessfulExchange).toHaveBeenCalledOnce();
  });

  it("delivers and persists an ambient turn the model chose to reply to, same as a direct turn", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve());
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange,
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("Hi there!", [], [], { action: "reply" })),
    };
    const service = new ChatConversationService(provider, store, guildStore());
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const result = await service.run({ ...input("hey yohta, what's up"), triggerMode: "ambient" }, deliver);
    expect(result.ambientAction).toBe("reply");
    expect(deliver).toHaveBeenCalledOnce();
    expect(commitSuccessfulExchange).toHaveBeenCalledOnce();
  });

  it("reports ambient channel history size in contextUsage", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
      applyMemoryActions: () => Promise.resolve(),
      forgetMemory: () => Promise.resolve(false),
      forgetAllMemories: () => Promise.resolve(0),
      getDmNotesEnabled: () => Promise.resolve(true),
      setDmNotesEnabled: () => Promise.resolve(),
    };
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")) };
    const service = new ChatConversationService(provider, store, guildStore());
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
});
