import { describe, expect, it, vi } from "vitest";

import { ChatConversationService, type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { GuildKnowledgeStore } from "../../src/application/chat/guild-knowledge-store.js";
import type { GuildMemorySelector } from "../../src/application/chat/guild-memory-selector.js";

function response(
  text: string,
  userMemoryActions: ChatResponse["userMemoryActions"] = [],
  guildKnowledgeCandidates: ChatResponse["guildKnowledgeCandidates"] = [],
): ChatResponse {
  return { text, userMemoryActions, guildKnowledgeCandidates, sources: [], usage: null, webSearchUsed: false };
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
    referencedMessage: null,
    images: [],
    webSearchEnabled: false,
    includeSources: false,
  };
}

describe("ChatConversationService", () => {
  it("does not commit when Discord delivery fails", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve());
    const store: ChatStateStore = {
      initialize: vi.fn(() => Promise.resolve()),
      load: vi.fn(() => Promise.resolve({ exchanges: [], memories: [] })),
      commitSuccessfulExchange,
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
        slot: "mascot", statement: "Pinecone is the mascot", source: "administrator",
      }]),
      propose: (proposal) => { proposals.push(proposal); return Promise.resolve(); },
    };
    const service = new ChatConversationService(provider, store, knowledgeStore);

    await service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text));
    expect(receivedKnowledgeCount).toBe(1);
    expect(proposals[0]?.candidates).toMatchObject([{ subjectId: "user", slot: "raid.friday" }]);
  });

  it("uses a replaceable guild-memory selector and reports selected context size", async () => {
    const store: ChatStateStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve({ exchanges: [], memories: [] }),
      commitSuccessfulExchange: () => Promise.resolve(),
    };
    const known = {
      id: "known", subjectType: "guild" as const, subjectId: "guild", topic: "community",
      slot: "mascot", statement: "Pinecone is the mascot", source: "administrator" as const,
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
    expect(result.contextUsage).toEqual({ guildKnowledgeRecords: 0, guildKnowledgeChars: 2 });
  });
});
