import { AuthorizedConversationService as ChatConversationService } from "../helpers/authorized-conversation-service.js";
import { ChatConversationService as ProductionConversationService } from "../../src/application/chat/chat-conversation-service.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";
import { attachDiagnosticStore, withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { MemoryChatTraceStore } from "../helpers/chat-trace-fixtures.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";

import { type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import { buildChatContext } from "../../src/infrastructure/chat/chat-structured-output.js";
import type { ChatStateStore, ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";
import type { ExampleExchangeSelector } from "../../src/application/chat/example-exchange-selector.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine, MemoryRepository } from "../../src/application/memory/memory.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import { captureIncompleteTurnProvenance } from "../../src/application/chat/context-provenance.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";

function response(
  text: string,
  userMemoryActions: ChatResponse["userMemoryActions"] = [],
  guildKnowledgeCandidates: ChatResponse["guildKnowledgeCandidates"] = [],
  ambient: { action: ChatResponse["ambientAction"]; emoji?: string } | null = null,
  historyReactions: ChatResponse["historyReactions"] = [],
): ChatResponse {
  return {
    text, userMemoryActions, guildKnowledgeCandidates, sources: [], usage: null, webSearchUsed: false,
    generatedImages: [], ambientAction: ambient?.action ?? null, reactionEmoji: ambient?.emoji ?? null,
    historyReactions,
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
  return { engine: new DefaultMemoryEngine(repository, embeddingsClient ?? null, null, undefined, null, null, null, () => true), repository };
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
    interaction: "direct_mention",
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
  it.each(["missing", "copied"] as const)("rejects a %s source authority before dispatch even without a character runtime", async (kind) => {
    const reply = vi.fn(() => Promise.resolve(response("must not generate")));
    const service = new ProductionConversationService({ reply }, baseStore(), testMemoryEngine().engine);
    try {
      await expect(service.run({ ...input("question"), ...(kind === "copied" ? { guardedContextPort: { ...guardedFixture().port } } : {}) },
        (output) => Promise.resolve(output.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
      expect(reply).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it.each(["disabled", "session_only"] as const)("does not create durable provenance in %s channels", async (mode) => {
    const commit = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("answer")) },
      baseStore({ commitSuccessfulExchange: commit }), testMemoryEngine().engine);
    try {
      await service.run({ ...input("question"), channelMemoryModes: { channel: mode } }, (output) => {
        expect(output.contextProvenance).toBeNull(); return Promise.resolve(output.text);
      });
      if (mode === "disabled") expect(commit).not.toHaveBeenCalled();
      else expect(commit).toHaveBeenCalledWith(expect.objectContaining({ contextProvenance: null }));
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("overwrites provider-supplied provenance and records known dependencies and confirmed delivery IDs", async () => {
    const forged = captureIncompleteTurnProvenance(decisionRequest({ currentBurst: [], channelHistory: [],
      currentEvent: { type: "message", messageId: "forged-source", channelId: "channel", authorId: "alice", timestampMs: 1, replyToMessageId: null, mentionedUserIds: [] },
    }), "answer")!;
    const commit = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve({ ...response("answer"),
      contextProvenance: { ...forged, coverage: "complete", unresolved: [] } }) }, baseStore({ commitSuccessfulExchange: commit }), testMemoryEngine().engine);
    try {
      const result = await service.run({ ...input("question"), sourceMessageId: "current",
        currentEvent: { type: "message", messageId: "current", channelId: "channel", authorId: "user", timestampMs: 1, replyToMessageId: null, mentionedUserIds: [] },
      }, (output) => {
        expect(output.contextProvenance).toMatchObject({ coverage: "complete", unresolved: [] });
        output.characterDeliveryProof = [{ messageId: "confirmed", content: output.text }]; return Promise.resolve(output.text);
      });
      expect(result.contextProvenance?.dependencies).toMatchObject([{ messageId: "current", authorId: "user" }]);
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ assistantMessageIds: ["confirmed"], contextProvenance: result.contextProvenance }));
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("clears stored sessions even when durable diagnostic cleanup fails", async () => {
    const { logger } = captureDiagnosticLogger();
    const traces = new MemoryChatTraceStore(); attachDiagnosticStore(logger, traces);
    vi.spyOn(traces, "forgetGuild").mockImplementation((guildId, sequence) => {
      traces.buffer.forgetGuild(guildId, sequence); return Promise.reject(new Error("SECRET_DISK_FAILURE"));
    });
    const clearRecentHistory = vi.fn(() => Promise.resolve());
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("answer")) }, baseStore({ clearRecentHistory }), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    try {
      await service.run({ ...input("question"), sourceMessageId: "source" }, (output) => Promise.resolve(output.text));
      expect(traces.lookup({ guildId: "guild", channelId: "channel", sourceMessageId: "source" })).toHaveLength(1);
      await expect(service.forgetConversation("guild", "user")).rejects.toThrow("diagnostic retention cleanup failed");
      expect(clearRecentHistory).toHaveBeenCalledWith("guild", "user");
      expect(traces.lookup({ guildId: "guild", channelId: "channel", sourceMessageId: "source" })).toEqual([]);
    } finally { service.stopScheduling(); await service.drain(); }
  });

  it("excludes retained metadata for an edited or deleted source", async () => {
    const { logger } = captureDiagnosticLogger(); const traces = new MemoryChatTraceStore(); attachDiagnosticStore(logger, traces);
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("answer")) }, baseStore(), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    try {
      await service.run({ ...input("question"), sourceMessageId: "source" }, (output) => Promise.resolve(output.text));
      service.excludeInteraction("guild", "channel", "source");
      await service.drain();
      expect(traces.lookup({ guildId: "guild", channelId: "channel", sourceMessageId: "source" })).toEqual([]);
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("explains repeated social pings after contextual interpretation", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const reply = vi.fn(() => Promise.resolve({ ...response("hi"), responseIntent: "social" as const }));
    const service = new ChatConversationService({ reply }, baseStore(), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    try {
      await service.run({ ...input(""), sourceMessageId: "first" }, (output) => Promise.resolve(output.text));
      await service.run({ ...input(""), sourceMessageId: "second" }, (output) => Promise.resolve(output.text));
      expect(reply).toHaveBeenCalledTimes(2);
      expect(records.filter((record) => record.event === "chat.turn.skipped")).toEqual([
        expect.objectContaining({ reason: "duplicate_ping", sourceMessageId: "second" }),
      ]);
    } finally { service.stopScheduling(); await service.drain(); }
  });

  it("records unavailable optional decisions without pretending the model chose silence", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const reply = vi.fn(() => Promise.resolve(response("unexpected")));
    const service = new ChatConversationService({ reply }, baseStore(), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    try {
      const result = await service.run({ ...input("follow-up"), interaction: "implicit_followup" }, (output) => Promise.resolve(output.text));
      expect(result.ambientAction).toBe("ignore");
      expect(reply).not.toHaveBeenCalled();
      expect(records.filter((record) => record.event === "chat.turn.skipped")).toEqual([
        expect.objectContaining({ reason: "decision_unavailable" }),
      ]);
    } finally { service.stopScheduling(); await service.drain(); }
  });

  it("records a delivery veto separately from a successful generation", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("answer")) }, baseStore(), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    const deliver = vi.fn(() => Promise.resolve("unexpected"));
    try {
      await expect(service.run({ ...input("question"), shouldDeliver: () => false }, deliver)).rejects.toBeInstanceOf(SocialOutputSuppressed);
      expect(deliver).not.toHaveBeenCalled();
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "chat.model.completed", status: "valid" }),
        expect.objectContaining({ event: "chat.output.suppressed", reason: "delivery_cancelled" }),
        expect.objectContaining({ event: "chat.queue.changed", reason: "operation_suppressed" }),
      ]));
    } finally { service.stopScheduling(); await service.drain(); }
  });

  it("correlates model, context, and one terminal delivery event without recording content", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("SECRET_ANSWER")) }, baseStore(), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    try {
      await withDiagnosticScope({ operation: "dispatch", sourceMessageId: "source" }, () => service.run(
        { ...input("SECRET_QUESTION"), sourceMessageId: "source" }, (output) => Promise.resolve(output.text)));
      const diagnostics = records.filter((record) => typeof record.event === "string");
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "context.guard.coverage", selected: 0 }),
        expect.objectContaining({ event: "chat.model.completed", purpose: "reply", status: "valid" }),
        expect.objectContaining({ event: "chat.turn.completed", outcome: "text_delivered", textDeliveryConfirmed: true }),
      ]));
      expect(diagnostics.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
      expect(new Set(diagnostics.map((record) => record.traceId)).size).toBe(1);
      expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
    } finally { service.stopScheduling(); await service.drain(); }
  });

  it("reports a failed model call rather than intentional silence", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const error = new DOMException("SECRET_ERROR_BODY", "TimeoutError");
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.reject(error) }, baseStore(), testMemoryEngine().engine,
      undefined, undefined, undefined, null, null, null, logger);
    try {
      await expect(service.run(input("SECRET_QUESTION"), () => Promise.resolve(""))).rejects.toBe(error);
      const diagnostics = records.filter((record) => typeof record.event === "string");
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "chat.model.completed", status: "failed", failure: "timeout" }),
        expect.objectContaining({ event: "chat.turn.completed", outcome: "failed", failure: "timeout", textDeliveryConfirmed: false }),
      ]));
      expect(diagnostics.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
      expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
    } finally { service.stopScheduling(); await service.drain(); }
  });

  it("cancels a buffered optional decision when a direct request starts", async () => {
    vi.useFakeTimers();
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("direct answer")) }, baseStore(), testMemoryEngine().engine);
    const buffered = vi.fn(); const version = service.optionalOpportunityVersion("guild", "channel");
    try {
      service.bufferOpportunity("guild", "channel", buffered);
      await service.run(input("A direct question"), (output) => Promise.resolve(output.text));
      expect(service.optionalOpportunityVersion("guild", "channel")).not.toBe(version);
      await vi.advanceTimersByTimeAsync(10000); expect(buffered).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); vi.useRealTimers(); }
  });
  it("excludes unproven legacy memory before source rendering or model processing", async () => {
    const { engine } = testMemoryEngine();
    for (let i = 0; i < 20; i++) await engine.ingest({ guildId: "guild", channelId: "channel", channelMode: "shared",
      assertedByUserId: "user", sourceMessageId: `source-${i}`, source: "live", now: 100 + i, proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "user", subjectType: "member", subjectId: "user",
        topic: "preference", slot: `food.fruit${i}`, statement: `likes apples variety ${i}`, channelScoped: false, sourceQuote: "<".repeat(350),
      }] });
    const individual = vi.spyOn(engine, "listSources");
    const batch = vi.spyOn(engine, "listPromptSources");
    const reply = vi.fn<(request: ChatRequest) => Promise<ChatResponse>>().mockResolvedValue(response("answer"));
    const service = new ChatConversationService({ reply }, baseStore(), engine);
    await service.run(input("Which apples do I like?"), (output) => Promise.resolve(output.text));
    expect(individual).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]![0].memories).toEqual([]);
    expect(reply.mock.calls[0]![0].guildKnowledge).toEqual([]);
    const context = buildChatContext(reply.mock.calls[0]![0]);
    const memories = context.match(/<user_memories>([\s\S]*?)<\/user_memories>/u)?.[1] ?? "";
    const knowledge = context.match(/<guild_knowledge[^>]*>([\s\S]*?)<\/guild_knowledge>/u)?.[1] ?? "";
    expect(memories.length + knowledge.length).toBeLessThanOrEqual(8000);
  });
  it("does not send passively observed messages when channel history is off", async () => {
    const reply = vi.fn<(request: ChatRequest) => Promise<ChatResponse>>().mockResolvedValue(response("answer"));
    const service = new ChatConversationService({ reply }, baseStore(), testMemoryEngine().engine);
    service.observe("guild", "channel", { messageId: "bystander", authorId: "other", authorDisplayName: "Other",
      timestampMs: Date.now(), content: "Never addressed the bot", imageCount: 0 });
    await service.run({ ...input("A direct question"), channelHistoryEnabled: false }, (output) => Promise.resolve(output.text));
    expect(reply.mock.calls[0]![0].channelHistory).toEqual([]);
  });

  it("forgetting clears observed context and prevents old fetched history returning in the process", async () => {
    const purgeUser = vi.fn(() => Promise.resolve());
    const reply = vi.fn<(request: ChatRequest) => Promise<ChatResponse>>().mockResolvedValue(response("answer"));
    const service = new ChatConversationService({ reply }, baseStore({ purgeUser }), testMemoryEngine().engine);
    const forgotten = { messageId: "forgotten", authorId: "user", authorDisplayName: "User",
      timestampMs: Date.now() - 1000, content: "Old private context", imageCount: 0 };
    service.observe("guild", "channel", forgotten);
    await service.forgetConversation("guild", "user");
    await service.run({ ...input("A new question"), channelHistoryEnabled: true, channelHistory: [forgotten] }, (output) => Promise.resolve(output.text));
    expect(purgeUser).toHaveBeenCalledWith("guild", "user");
    expect(reply.mock.calls[0]![0].channelHistory).toEqual([]);
  });
  it.each(["implicit_followup", "group_conversation"] as const)("pauses %s without a structured decision runtime", async (interaction) => {
    const reply = vi.fn(() => Promise.resolve(response("must not generate")));
    const service = new ChatConversationService({ reply }, baseStore(), testMemoryEngine().engine);
    const deliver = vi.fn(() => Promise.resolve("must not send"));
    expect((await service.run({ ...input("What are we deciding?"), interaction }, deliver)).ambientAction).toBe("ignore");
    expect(reply).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
  });
  it.each(["name_address", "direct_mention"] as const)("preserves addressed turns during unrelated context changes (%s)", async (interaction) => {
    let finish!: (value: ChatResponse) => void;
    const pending = new Promise<ChatResponse>((resolve) => { finish = resolve; });
    const reply = vi.fn(() => pending);
    const service = new ChatConversationService({ reply }, baseStore(), testMemoryEngine().engine);
    const deliver = vi.fn(() => Promise.resolve("answer"));
    const turn = service.run({ ...input("What are we deciding?"), interaction, channelHistoryEnabled: true }, deliver);
    const result = turn.then(() => "delivered", () => "suppressed");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    service.observe("guild", "channel", { messageId: "new-topic", timestampMs: Date.now(), authorId: "other",
      authorDisplayName: "Other", content: "We moved on to a different topic", imageCount: 0 });
    finish(response("answer", [], [], { action: "reply" }));
    expect(await result).toBe("delivered");
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("does not turn legacy sessions or assistant-only summaries into public facts", async () => {
    const store = baseStore({ commitSuccessfulExchange: () => Promise.resolve({ droppedExchanges: [
      { user: { content: "I like apples", createdAt: 100 }, assistant: { content: "Bob likes pears", createdAt: 101 } },
    ] }) });
    const summarizeDroppedExchanges = vi.fn(() => Promise.resolve([
      { slot: "scene.fruit", statement: "Bob likes apples", subjectType: "member" as const, sourceQuote: "I like apples" },
      { slot: "scene.pears", statement: "Bob likes pears", subjectType: "member" as const, sourceQuote: "Bob likes pears" },
    ]));
    const { engine } = testMemoryEngine();
    const ingest = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("ok")), summarizeDroppedExchanges }, store, engine);
    await service.run(input("What happened?"), (output) => Promise.resolve(output.text));
    await service.drain();
    expect(summarizeDroppedExchanges).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("allows silence or reaction-only for bare pings without delivery, extraction, or fallback text", async () => {
    const commit = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const extract = vi.fn(() => Promise.resolve([]));
    const provider: ChatProvider = { reply: () => Promise.resolve({ ...response("", [], [], { action: "ignore", emoji: "👀" }), responseIntent: "social" }), extractPersonalMemories: extract };
    const service = new ChatConversationService(provider, baseStore({ commitSuccessfulExchange: commit }), testMemoryEngine().engine);
    const deliver = vi.fn(() => Promise.resolve("must not deliver"));
    const result = await service.run({ ...input(""), allowSilentDirect: true }, deliver);
    await service.drain();
    expect(result).toMatchObject({ ambientAction: "ignore", reactionEmoji: "👀", text: "" });
    expect(deliver).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled();
  });

  it("preserves meaningful direct requests even if optional silence was incorrectly requested", async () => {
    const provider: ChatProvider = { reply: () => Promise.resolve(response("the answer", [], [], { action: "ignore" })) };
    const service = new ChatConversationService(provider, baseStore(), testMemoryEngine().engine);
    const deliver = vi.fn((result: ChatResponse) => Promise.resolve(result.text));
    const result = await service.run({ ...input("What time is the event tomorrow?"), allowSilentDirect: true }, deliver);
    expect(result.ambientAction).toBe("reply"); expect(deliver).toHaveBeenCalledOnce();
  });
  it("answers a contextual request after a social ping without disabling capabilities or repeat-suppressing it", async () => {
    let calls = 0;
    const provider: ChatProvider = { imageGenerationSupported: true, reply: (request) => {
      calls++;
      if (calls === 1) return Promise.resolve({ ...response("hey"), responseIntent: "social" });
      expect(request.channelHistory.map((event) => event.messageId)).toContain("question");
      expect(request.enabledTools).toEqual([]);
      expect(request.imageGenerationEnabled).toBe(true);
      return Promise.resolve({ ...response("Here is the answer"), responseIntent: "answer", referentSourceIds: ["question"] });
    } };
    const tools = new ChatToolRegistry([{ name: "context_lookup", outputKind: "context", description: "Read-only", parameters: {}, execute: (): Promise<{ content: string }> => Promise.resolve({ content: "result" }) }]);
    const service = new ChatConversationService(provider, baseStore(), testMemoryEngine().engine, undefined, undefined, undefined, null, null, tools);
    const deliver = vi.fn((result: ChatResponse) => Promise.resolve(result.text));
    await service.run({ ...input(""), sourceMessageId: "first", allowSilentDirect: true }, deliver);
    const result = await service.run({ ...input(""), sourceMessageId: "second", allowSilentDirect: true, toolsEnabled: true, imageGenerationEnabled: true,
      channelHistory: [{ messageId: "question", timestampMs: 1, authorId: "user", authorDisplayName: "User", content: "Can you explain the earlier problem?", imageCount: 0 }] }, deliver);
    expect(result.text).toBe("Here is the answer"); expect(result.ambientAction).toBe("reply"); expect(deliver).toHaveBeenCalledTimes(2);
  });
  it("rejects direct generation with unknown context evidence instead of silently abstaining", async () => {
    const provider: ChatProvider = { reply: () => Promise.resolve({ ...response("invented answer"), referentSourceIds: ["unknown"] }) };
    const service = new ChatConversationService(provider, baseStore(), testMemoryEngine().engine);
    const deliver = vi.fn(() => Promise.resolve("must not send"));
    await expect(service.run(input("What happened?"), deliver)).rejects.toThrow("Invalid contextual response");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("shadow evaluation does not deliver output, persist facts, or run dedicated extraction", async () => {
    const extract = vi.fn(() => Promise.resolve([]));
    const commit = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("would reply")), extractPersonalMemories: extract },
      baseStore({ commitSuccessfulExchange: commit }), testMemoryEngine().engine);
    const deliver = vi.fn(() => Promise.resolve("must not deliver"));
    await service.run({ ...input("continuation"), interaction: "implicit_followup", shadowMode: true }, deliver);
    await service.drain();
    expect(deliver).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(extract).not.toHaveBeenCalled();
  });
  it("treats recipient corrections as conversation routing rather than a durable member fact", async () => {
    const extraction = vi.fn(() => Promise.resolve([])); const { engine, repository } = testMemoryEngine();
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Understood", [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "conversation.target", statement: "prefers talking to someone else", sourceQuote: "I am talking to someone else" }])), extractPersonalMemories: extraction };
    const service = new ChatConversationService(provider, baseStore(), engine);
    await service.run(input("I am talking to someone else"), (output) => Promise.resolve(output.text));
    await service.drain(); expect(extraction).not.toHaveBeenCalled();
    expect(await repository.listByUser("guild", "user")).toEqual([]);
  });
  it("reaction notes cannot create facts or run dedicated extraction even when quoting bot assertions", async () => {
    const extraction = vi.fn(() => Promise.resolve([]));
    const commit = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const { engine, repository } = testMemoryEngine();
    const store = baseStore({ commitSuccessfulExchange: commit });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("follow-up", [{
        action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit",
        statement: "likes apples", sourceQuote: "I like apples",
      }])), extractPersonalMemories: extraction,
    };
    const service = new ChatConversationService(provider, store, engine);
    await expect(service.run({ ...input('(reacted to your message "I like apples")'), interaction: "reaction" }, (result) => Promise.resolve(result.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await service.drain();
    expect(extraction).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(await repository.listByUser("guild", "user")).toEqual([]);
  });
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
    const exchanges: ChatSessionExchange[] = [];
    const seenHistoryLengths: number[] = [];
    const store = baseStore({
      load: () => Promise.resolve({ exchanges: [...exchanges], memories: [] }),
      commitSuccessfulExchange: (commit) => {
        exchanges.push({
          user: { content: commit.userMessage, createdAt: commit.sourceTimestampMs ?? commit.now,
            sourceMessageId: commit.sourceMessageId ?? null, channelMemoryMode: commit.channelMemoryMode ?? "shared" },
          assistant: { content: commit.assistantMessage, createdAt: commit.now, messageIds: commit.assistantMessageIds ?? [] },
          contextProvenance: commit.contextProvenance ?? null,
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
        { action: "upsert", subjectUserId: "invented", topic: "preference", slot: "food", statement: "likes apples", sourceQuote: null },
        { action: "upsert", subjectUserId: "user", topic: "unknown", slot: "food", statement: "likes apples", sourceQuote: null },
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "api", statement: "api_key = secret-value-123", sourceQuote: null },
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples", sourceQuote: "I like green apples" },
      ])),
    };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("I like green apples, remember this"), (reply) => Promise.resolve(reply.text));
    const stored = await engine.listUserMemories("guild", "user", "channel");
    expect(stored).toMatchObject([{ subjectId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
  });

  it("threads the originating Discord message id into a live memory write", async () => {
    const store = baseStore();
    const memoryActions: ChatResponse["userMemoryActions"] = [
      { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples", sourceQuote: "I like green apples" },
    ];
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", memoryActions)) };
    const { engine } = testMemoryEngine();
    const ingestSpy = vi.spyOn(engine, "ingest");
    const service = new ChatConversationService(provider, store, engine);

    await service.run({ ...input("I like green apples, remember this"), sourceMessageId: "msg-123" }, (reply) => Promise.resolve(reply.text));
    expect(ingestSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceMessageId: "msg-123" }));
  });

  it("runs live memory writes inside the shared per-subject mutation boundary", async () => {
    const store = baseStore();
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", [{
      action: "upsert", subjectUserId: "user", topic: "preference",
      slot: "food.fruit", statement: "likes green apples", sourceQuote: "I like green apples",
    }])) };
    const { engine } = testMemoryEngine();
    const runForSubject = vi.fn();
    const coordinator = {
      runForSubject<T>(guildId: string, subjectId: string, operation: () => Promise<T>): Promise<T> {
        runForSubject(guildId, subjectId, operation);
        return operation();
      },
    };
    const service = new ChatConversationService(
      provider, store, engine, undefined, undefined, undefined, null, null, null, null, null, null,
      coordinator,
    );

    await service.run(input("I like green apples, remember this"), (reply) => Promise.resolve(reply.text));

    expect(runForSubject).toHaveBeenCalledWith("guild", "user", expect.any(Function));
    await expect(engine.listUserMemories("guild", "user", "channel")).resolves.toHaveLength(1);
  });

  it("rejects a guild-knowledge candidate whose sourceQuote was actually said by someone else, not the claimed subject", async () => {
    // Regression for a real production incident: the model answered a
    // question about "LW" by quoting a line Ginco actually said, and
    // proposed a guild-knowledge candidate crediting LW with it. The
    // attribution-verification pass (see attribution-verification.ts) fixes
    // the reply *text* for cases like this, but does nothing about a memory/
    // guild-knowledge proposal riding along in the same response — this is
    // the check that catches it before it becomes a durable write.
    const store = baseStore();
    const candidates: ChatResponse["guildKnowledgeCandidates"] = [{
      subjectType: "member", subjectId: "lw-user", topic: "public_interest",
      slot: "fandom.grey_fur", statement: "is a grey-fur fan", channelScoped: false,
      sourceQuote: "friend has grey fur",
    }];
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", [], candidates)) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run({
      ...input("is LW a fan?"),
      mentionedUsers: [{ id: "lw-user", displayName: "LW", roleNames: [] }],
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco-user", authorDisplayName: "Ginco", content: "friend has grey fur", imageCount: 0 },
      ],
    }, (reply) => Promise.resolve(reply.text));

    expect(result.guildKnowledgeCandidates).toEqual([]);
  });

  it("keeps a guild-knowledge candidate whose sourceQuote is genuinely something the claimed subject said", async () => {
    const store = baseStore();
    const candidates: ChatResponse["guildKnowledgeCandidates"] = [{
      subjectType: "member", subjectId: "ginco-user", topic: "public_interest",
      slot: "fandom.grey_fur", statement: "is a grey-fur fan", channelScoped: false,
      sourceQuote: "friend has grey fur",
    }];
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", [], candidates)) };
    const { engine, repository } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);

    const result = await service.run({
      ...input("what is Ginco into?"),
      mentionedUsers: [{ id: "ginco-user", displayName: "Ginco", roleNames: [] }],
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco-user", authorDisplayName: "Ginco", content: "friend has grey fur", imageCount: 0 },
      ],
    }, (reply) => Promise.resolve(reply.text));

    expect(result.guildKnowledgeCandidates).toEqual([]);
    expect(await repository.listBySubject("guild", "ginco-user")).toContainEqual(expect.objectContaining({ statement: "is a grey-fur fan", channelId: "channel", contextProvenance: expect.objectContaining({ coverage: "complete" }) as unknown }));
  });

  it("rejects a private-memory upsert whose sourceQuote doesn't actually appear anywhere in this turn", async () => {
    const store = baseStore();
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", [
      { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes durian", sourceQuote: "I love durian" },
    ])) };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("what's for lunch"), (reply) => Promise.resolve(reply.text));

    await expect(engine.listUserMemories("guild", "user", "channel")).resolves.toHaveLength(0);
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
          sourceQuote: "I organize Friday raids",
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
      statement: "ExampleBot is the mascot", status: "active", source: "administrator", importance: 1,
      embedding: null, embeddingModel: null, expiresAt: null, now: 0,
      sourceMessageId: null, sourceChannelId: null, assertedByUserId: null,
    });
    const service = new ChatConversationService(provider, store, engine);

    await service.run(input("I organize Friday raids"), (reply) => Promise.resolve(reply.text));
    expect(receivedKnowledgeCount).toBe(0);
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
        sourceQuote: "I organize Friday raids",
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
        sourceQuote: "I organize Friday raids",
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

  it("runs a dedicated post-reply extraction pass and ingests what it finds, even when the reply model itself returned no memory actions", async () => {
    const store = baseStore();
    const extractPersonalMemories = vi.fn(() => Promise.resolve([
      { action: "upsert" as const, aboutSpeaker: true, importance: "medium" as const, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
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
        "I like green apples", "", { id: "user", displayName: "User" }, expect.objectContaining({ beforeAttempt: expect.any(Function) as unknown }),
      );
    });
    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user", "channel");
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
      { action: "upsert" as const, aboutSpeaker: true, importance: "medium" as const, sourceQuote: "Bob likes green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Noted!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run({ ...input("Bob likes green apples"), mentionedUsers: [{ id: "bob", displayName: "Bob", roleNames: [] }] }, deliver);

    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user", "channel");
      expect(stored).toMatchObject([{ subjectId: "user", statement: "likes green apples" }]);
    });
    // Never Bob's profile — that's the one thing this design guarantees
    // structurally. Whether it should have been written at all (it
    // shouldn't — the mock here incorrectly claims aboutSpeaker: true) is
    // a model-correctness question the next test covers, not this one.
    await expect(engine.listUserMemories("guild", "bob", "channel")).resolves.toHaveLength(0);
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
      { action: "upsert" as const, aboutSpeaker: false, importance: "medium" as const, sourceQuote: "Bob likes pizza", topic: "preference", slot: "food.pizza", statement: "likes pizza" },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Noted!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run({ ...input("Bob likes pizza"), mentionedUsers: [{ id: "bob", displayName: "Bob", roleNames: [] }] }, deliver);

    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalled();
    });
    await expect(engine.listUserMemories("guild", "user", "channel")).resolves.toHaveLength(0);
    await expect(engine.listUserMemories("guild", "bob", "channel")).resolves.toHaveLength(0);
  });

  it("drops an action whose sourceQuote isn't actually in the user's message, even though aboutSpeaker is true — grounding, not just the model's self-check", async () => {
    const store = baseStore();
    // "you probably love jazz" is grounded in nothing the user actually
    // said — a sourceQuote that doesn't appear in the real message text
    // means the app can't verify it traces back to the user at all (see
    // personal-memory-extraction.ts's evidence rule).
    const extractPersonalMemories = vi.fn(() => Promise.resolve([
      { action: "upsert" as const, aboutSpeaker: true, importance: "medium" as const, sourceQuote: "you probably love jazz", topic: "preference", slot: "music.genre", statement: "loves jazz" },
    ]));
    const provider: ChatProvider = { reply: () => Promise.resolve(response("Interesting!")), extractPersonalMemories };
    const { engine } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    await service.run(input("hmm maybe"), deliver);

    await vi.waitFor(() => {
      expect(extractPersonalMemories).toHaveBeenCalled();
    });
    await expect(engine.listUserMemories("guild", "user", "channel")).resolves.toHaveLength(0);
  });

  it("keeps a slow background extraction from clobbering a later turn's correction — memory writes for one user stay ordered even though the reply doesn't wait for extraction", async () => {
    const store = baseStore();
    let resolveSlowExtraction!: (actions: readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string; importance: "low" | "medium" | "high" }[]) => void;
    const slowExtraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string; importance: "low" | "medium" | "high" }[]>((resolve) => {
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
          { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "hates apples", sourceQuote: "I hate apples" },
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
    resolveSlowExtraction([{ action: "upsert", aboutSpeaker: true, importance: "medium" as const, sourceQuote: "I like apples", topic: "preference", slot: "food.fruit", statement: "likes apples" }]);
    await turn2;

    // If extraction and turn 2 could race, "likes apples" landing after
    // "hates apples" would silently resurrect the stale fact. Serialized,
    // the correction always wins.
    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user", "channel");
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
    let resolveSlowExtraction!: (actions: readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string; importance: "low" | "medium" | "high" }[]) => void;
    const slowExtraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string; importance: "low" | "medium" | "high" }[]>((resolve) => {
      resolveSlowExtraction = resolve;
    });
    let replyCall = 0;
    const provider: ChatProvider = {
      reply: () => {
        replyCall += 1;
        if (replyCall === 1) return Promise.resolve(response("Noted!"));
        return Promise.resolve(response("Got it!", [
          { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "hates apples", sourceQuote: "I hate apples" },
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
    resolveSlowExtraction([{ action: "upsert", aboutSpeaker: true, importance: "medium" as const, sourceQuote: "I like apples", topic: "preference", slot: "food.fruit", statement: "likes apples" }]);
    await turn2;

    await vi.waitFor(async () => {
      const stored = await engine.listUserMemories("guild", "user", "channel");
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
    const slowExtraction = new Promise<readonly { action: "upsert"; aboutSpeaker: boolean; sourceQuote: string; topic: string; slot: string; statement: string; importance: "low" | "medium" | "high" }[]>((resolve) => {
      resolveExtraction = (): void => resolve([
        { action: "upsert", aboutSpeaker: true, importance: "medium" as const, sourceQuote: "I like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
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
    const stored = await engine.listUserMemories("guild", "user", "channel");
    expect(stored).toMatchObject([{ statement: "likes green apples" }]);
  });

  it("drain() covers post-turn work registered after a gated commit", async () => {
    let releaseCommit!: () => void; const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let releaseExtract!: () => void; const extractionGate = new Promise<void>((resolve) => { releaseExtract = resolve; });
    let releaseSummary!: () => void; const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let previous: ChatSessionExchange | null = null;
    let commits = 0;
    const store = baseStore({ commitSuccessfulExchange: async (commit) => {
      if (++commits > 1) { await commitGate; return { droppedExchanges: [previous!] }; }
      previous = { user: { content: commit.userMessage, createdAt: commit.sourceTimestampMs!, sourceMessageId: commit.sourceMessageId!, channelMemoryMode: "shared" },
        assistant: { content: commit.assistantMessage, createdAt: commit.now, messageIds: commit.assistantMessageIds! }, contextProvenance: commit.contextProvenance! };
      return { droppedExchanges: [] };
    } });
    let extractions = 0;
    const extractPersonalMemories = vi.fn(async () => { if (++extractions > 1) await extractionGate; return []; });
    const summarizeDroppedExchanges = vi.fn(async () => { await summaryGate; return []; });
    const service = new ChatConversationService({ reply: (): Promise<ChatResponse> => Promise.resolve(response("Noted")), extractPersonalMemories, summarizeDroppedExchanges }, store, testMemoryEngine().engine);
    try {
      await service.run(input("Earlier apples"), (output) => Promise.resolve(output.text)); await service.drain();
      const deliver = vi.fn((output: ChatResponse) => Promise.resolve(output.text));
      const turn = service.run(input("Current pears"), deliver);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
      let drained = false; const draining = service.drain().then(() => { drained = true; });
      releaseCommit(); await turn;
      await vi.waitFor(() => expect(extractPersonalMemories).toHaveBeenCalledTimes(2));
      expect(drained).toBe(false); releaseExtract();
      await vi.waitFor(() => expect(summarizeDroppedExchanges).toHaveBeenCalledOnce());
      expect(drained).toBe(false); releaseSummary(); await draining; expect(drained).toBe(true);
    } finally { releaseCommit(); releaseExtract(); releaseSummary(); service.stopScheduling(); await service.drain(); }
  });

  it("delivers a reply and reacts in the same ambient turn when both are set", async () => {
    const commitSuccessfulExchange = vi.fn(() => Promise.resolve({ droppedExchanges: [] }));
    const store = baseStore({ commitSuccessfulExchange });
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("That's a good one!", [], [], { action: "reply", emoji: "😂" })),
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));

    const result = await service.run({ ...input("yohta that's hilarious"), interaction: "name_address" }, deliver);
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

    const result = await service.run({ ...input("hey yohta, what's up"), interaction: "name_address" }, deliver);
    expect(result.ambientAction).toBe("reply");
    expect(deliver).toHaveBeenCalledOnce();
    expect(commitSuccessfulExchange).toHaveBeenCalledOnce();
  });

  it("reports ambient channel history size in contextUsage", async () => {
    const store = baseStore();
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok")) };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const channelHistory = [
      { messageId: "m1", timestampMs: 0, authorId: "other", authorDisplayName: "Other", content: "earlier chatter", imageCount: 0 },
    ];

    const result = await service.run(
      { ...input("hi"), channelHistory },
      (reply) => Promise.resolve(reply.text),
    );
    expect(result.contextUsage).toMatchObject({
      channelHistoryMessages: 1,
      channelHistoryChars: expect.any(Number) as unknown,
    });
  });

  it("keeps a historyReaction whose messageId is a real channel-history line, drops one that isn't, and drops one targeting the triggering message itself", async () => {
    const store = baseStore();
    const channelHistory = [
      { messageId: "real-1", timestampMs: 0, authorId: "other", authorDisplayName: "Other", content: "a funny message", imageCount: 0 },
    ];
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [], [], null, [
        { messageId: "real-1", emoji: "😂" },
        { messageId: "made-up-id", emoji: "👀" },
        { messageId: "trigger-message", emoji: "🙄" },
      ])),
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run(
      { ...input("hi"), sourceMessageId: "trigger-message", channelHistory },
      (reply) => Promise.resolve(reply.text),
    );

    expect(result.historyReactions).toEqual([{ messageId: "real-1", emoji: "😂" }]);
  });

  it("caps historyReactions at 3 and dedupes by messageId even if the provider returns more", async () => {
    const store = baseStore();
    const channelHistory = [1, 2, 3, 4].map((n) => ({
      messageId: `m${n}`, timestampMs: 0, authorId: "other", authorDisplayName: "Other", content: `line ${n}`, imageCount: 0,
    }));
    const provider: ChatProvider = {
      reply: () => Promise.resolve(response("ok", [], [], null, [
        { messageId: "m1", emoji: "😂" },
        { messageId: "m1", emoji: "🔥" },
        { messageId: "m2", emoji: "👀" },
        { messageId: "m3", emoji: "🙌" },
        { messageId: "m4", emoji: "💀" },
      ])),
    };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run(
      { ...input("hi"), channelHistory },
      (reply) => Promise.resolve(reply.text),
    );

    expect(result.historyReactions).toEqual([
      { messageId: "m1", emoji: "😂" },
      { messageId: "m2", emoji: "👀" },
      { messageId: "m3", emoji: "🙌" },
    ]);
  });

  it("ignores caller-supplied overflow without registered ancestry", async () => {
    const store = baseStore();
    const summarizeReplyChainOverflow = vi.fn(() => Promise.resolve("Alice mentioned liking apples earlier."));
    const reply = vi.fn(() => Promise.resolve(response("ok")));
    const provider: ChatProvider = { reply, summarizeReplyChainOverflow };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    await service.run({
      ...input("what did she say"),
    }, (r) => Promise.resolve(r.text));

    expect(summarizeReplyChainOverflow).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ replyChainSummary: null }),
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
    }, (r) => Promise.resolve(r.text));

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ replyChainSummary: null }), undefined);
  });

  it("repairs with the original persona and context without delivering verifier notes or repeating tools", async () => {
    const store = baseStore();
    const verifyAttribution = vi.fn(() => Promise.resolve({
      needsCorrection: true,
      correctionNotes: "CONTEXT: ginco authored the quote; LW did not.",
    }));
    const reply = vi.fn()
      .mockResolvedValueOnce(response("LW said that."))
      .mockResolvedValueOnce(response("欸，那句是 Ginco 說的啦。"));
    const provider: ChatProvider = { reply, verifyAttribution };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);
    const deliver = vi.fn((r: ChatResponse) => Promise.resolve(r.text));

    const result = await service.run({
      ...input("who said that"),
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco", authorDisplayName: "Ginco", content: "friend has grey fur", imageCount: 0 },
      ],
    }, deliver);

    expect(verifyAttribution).toHaveBeenCalledWith(
      "LW said that.",
      [{ authorId: "ginco", authorDisplayName: "Ginco", content: "friend has grey fur" }],
      "who said that", expect.any(Function),
    );
    const original = reply.mock.calls[0]![0] as ChatRequest;
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1]).toEqual([{
      ...original,
      attributionRepair: { draft: "LW said that.", notes: "CONTEXT: ginco authored the quote; LW did not." },
      enabledTools: [], webSearchMode: "off", imageGenerationEnabled: false, historyReactionsEnabled: false,
      beforeModelAttempt: expect.any(Function) as unknown,
    }]);
    expect(result.text).toBe("欸，那句是 Ginco 說的啦。");
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: result.text }));
  });

  it.each(["failure", "empty"])("keeps the draft when the main-model repair returns %s", async (mode) => {
    const reply = vi.fn().mockResolvedValueOnce(response("Original draft."));
    if (mode === "failure") reply.mockRejectedValueOnce(new Error("repair unavailable"));
    else reply.mockResolvedValueOnce(response(" "));
    const verifyAttribution = vi.fn().mockResolvedValue({ needsCorrection: true, correctionNotes: "Internal diagnostics" });
    const service = new ChatConversationService({ reply, verifyAttribution }, baseStore(), testMemoryEngine().engine);
    const deliver = vi.fn((r: ChatResponse) => Promise.resolve(r.text));
    const result = await service.run({
      ...input("who said that"),
      channelHistory: [{ messageId: "m1", timestampMs: 0, authorId: "ginco", authorDisplayName: "Ginco", content: "hello", imageCount: 0 }],
    }, deliver);
    expect(result.text).toBe("Original draft.");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("skips attribution verification entirely when there's no reply-chain or channel-history context", async () => {
    const store = baseStore();
    const verifyAttribution = vi.fn(() => Promise.resolve({ needsCorrection: true, correctionNotes: "should not be used" }));
    const reply = vi.fn(() => Promise.resolve(response("ok")));
    const provider: ChatProvider = { reply, verifyAttribution };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run(input("hi"), (r) => Promise.resolve(r.text));

    expect(verifyAttribution).not.toHaveBeenCalled();
    expect(result.text).toBe("ok");
  });

  it("delivers the unverified draft when attribution verification fails", async () => {
    const store = baseStore();
    const verifyAttribution = vi.fn(() => Promise.reject(new Error("provider down")));
    const reply = vi.fn(() => Promise.resolve(response("LW said that.")));
    const provider: ChatProvider = { reply, verifyAttribution };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run({
      ...input("who said that"),
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco", authorDisplayName: "Ginco", content: "friend has grey fur", imageCount: 0 },
      ],
    }, (r) => Promise.resolve(r.text));

    expect(result.text).toBe("LW said that.");
  });

  it("leaves the draft unchanged when verification reports needsCorrection false", async () => {
    const store = baseStore();
    const verifyAttribution = vi.fn(() => Promise.resolve({ needsCorrection: false, correctionNotes: null }));
    const reply = vi.fn(() => Promise.resolve(response("Ginco said that.")));
    const provider: ChatProvider = { reply, verifyAttribution };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run({
      ...input("who said that"),
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco", authorDisplayName: "Ginco", content: "friend has grey fur", imageCount: 0 },
      ],
    }, (r) => Promise.resolve(r.text));

    expect(result.text).toBe("Ginco said that.");
  });

  it("strips untrusted-data fence markers from the main model's repair", async () => {
    const store = baseStore();
    const verifyAttribution = vi.fn(() => Promise.resolve({
      needsCorrection: true,
      correctionNotes: "<<<BEGIN-UNTRUSTED-DATA>>>\nGinco said that, not LW.\n<<<END-UNTRUSTED-DATA>>>",
    }));
    const reply = vi.fn()
      .mockResolvedValueOnce(response("LW said that."))
      .mockResolvedValueOnce(response("<<<BEGIN-UNTRUSTED-DATA>>>\nGinco said that, not LW.\n<<<END-UNTRUSTED-DATA>>>"));
    const provider: ChatProvider = { reply, verifyAttribution };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run({
      ...input("who said that"),
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco", authorDisplayName: "Ginco", content: "friend has grey fur", imageCount: 0 },
      ],
    }, (r) => Promise.resolve(r.text));

    expect(result.text).toBe("Ginco said that, not LW.");
  });

  it("delivers the draft untouched when the repair echoes the draft", async () => {
    const store = baseStore();
    const draft = "冰寒刺骨\n競技場中的所有人都會受到緩速 II 和挖掘疲勞 II 效果。";
    const verifyAttribution = vi.fn(() => Promise.resolve({
      needsCorrection: true,
      correctionNotes: `<<<BEGIN-UNTRUSTED-DATA>>>\n${draft}\n<<<END-UNTRUSTED-DATA>>>`,
    }));
    const reply = vi.fn(() => Promise.resolve(response(draft)));
    const provider: ChatProvider = { reply, verifyAttribution };
    const service = new ChatConversationService(provider, store, testMemoryEngine().engine);

    const result = await service.run({
      ...input("翻譯"),
      channelHistory: [
        { messageId: "m1", timestampMs: 0, authorId: "ginco", authorDisplayName: "Ginco", content: "Bitter Cold", imageCount: 0 },
      ],
    }, (r) => Promise.resolve(r.text));

    expect(result.text).toBe(draft);
  });

  it("keeps a guild-knowledge candidate about a reply-chain author, not just the current user or an @mention", async () => {
    const store = baseStore();
    const candidates: ChatResponse["guildKnowledgeCandidates"] = [
      {
        subjectType: "member", subjectId: "authorA", topic: "community_activity",
        slot: "fruit.orange", statement: "likes orange", channelScoped: false, sourceQuote: "i like apple",
      },
    ];
    const provider: ChatProvider = { reply: () => Promise.resolve(response("ok", [], candidates)) };
    const { engine, repository } = testMemoryEngine();
    const service = new ChatConversationService(provider, store, engine);

    const result = await service.run({
      ...input("i think he likes orange"),
      replyChain: [{ messageId: "m1", timestampMs: 0, authorId: "authorA", authorDisplayName: "A", content: "i like apple", imageCount: 0 }],
    }, (reply) => Promise.resolve(reply.text));

    expect(result.guildKnowledgeCandidates).toEqual([]);
    expect(await repository.listBySubject("guild", "authorA")).toContainEqual(expect.objectContaining({ statement: "likes orange", channelId: "channel", contextProvenance: expect.objectContaining({ coverage: "complete" }) as unknown }));
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
    await expect(driftStore.getScoped("guild", "channel")).resolves.toBeNull();
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
