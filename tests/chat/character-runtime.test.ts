import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDocument, memoryProvider, guildId, actorUserId } from "../helpers/settings-fixtures.js";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { CharacterMemory } from "../../src/application/chat/character-memory.js";
import { CharacterCallbacks, CallbackKnownFailure, callbackState, callbackDateUnresolved } from "../../src/application/chat/character-callbacks.js";
import { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { CharacterModuleRegistry } from "../../src/application/chat/character-module-registry.js";
import { ThoughtsModule } from "../../src/application/chat/character-modules/thoughts.js";
import { AddressingModule } from "../../src/application/chat/character-modules/addressing.js";
import { endOfLocalDay, startOfLocalDay } from "../../src/application/chat/character-calendar.js";
import { CharacterDecisionService } from "../../src/application/chat/character-decision.js";
import { buildChatContext } from "../../src/infrastructure/chat/chat-structured-output.js";
import { characterInactiveReason, characterSettingsSchema } from "../../src/application/chat/character-settings.js";
import { ChatScheduler, balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { Memory, RepositoryIngestInput } from "../../src/application/memory/memory.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection, type SqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";

const channelId = "500000000000000001";
const connections: SqliteDatabaseConnection[] = [];
afterEach(() => { connections.splice(0).forEach((connection) => connection.close()); vi.restoreAllMocks(); });
function response(text = "hey"): ChatResponse { return { text, userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [], ambientAction: "reply", reactionEmoji: null, historyReactions: [] }; }
function request(): ChatRequest { return { guildId, channelId, personality: "A fictional character who likes cats", personaLore: [], personaDrift: null,
  exampleExchanges: [{ tags: "chat", user: "hi", character: "hey" }], userCustomization: null, currentUser: { id: actorUserId, displayName: "Alice", roleNames: [] },
  mentionedUsers: [], recentHistory: [], memories: [], guildKnowledge: [], causalChains: [], message: "hey", replyChain: [], replyChainSummary: null,
  channelHistory: [], birthday: null, images: [], webSearchMode: "off", imageGenerationEnabled: false, includeSources: false, triggerMode: "direct", botUserId: "bot" }; }
function record(overrides: Partial<RepositoryIngestInput> = {}): RepositoryIngestInput { return { guildId, kind: "fact", audience: "guild", ownerUserId: null,
  channelId: null, isolationChannelId: null, subjectType: "member", subjectId: actorUserId, topic: "schedule", slot: "exam", statement: "exam on 2026-10-15",
  status: "active", source: "live", importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 1000,
  sourceMessageId: "human-source", sourceChannelId: channelId, assertedByUserId: actorUserId, ...overrides }; }
function setup(clock: () => number = () => Date.now()): { connection: SqliteDatabaseConnection; repository: SqliteMemoryRepository; profiles: ReturnType<typeof memoryProvider>; provider: ChatProvider; runtime: CharacterRuntime } {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "character-runtime-"))); connections.push(connection);
  const repository = new SqliteMemoryRepository(connection.database); const doc = freshDocument(); doc.features.chatbot = true; doc.features.channelHistory = true; doc.channels.chatbot = [channelId];
  const profiles = memoryProvider(doc); const provider: ChatProvider = { reply: vi.fn(() => Promise.resolve(response())), generateCharacterData: vi.fn(() => Promise.resolve({ text: "enjoys fruit jokes" })) };
  const runtime = new CharacterRuntime(profiles, repository, { generateCharacterData: provider.generateCharacterData! }, provider, undefined, null, clock);
  return { connection, repository, profiles, provider, runtime };
}
describe("character module integration", () => {
  it("keeps a composed module inactive when an implementation dependency is absent", () => {
    const registry = new CharacterModuleRegistry(); registry.register(new ThoughtsModule());
    expect(registry.has("thoughts")).toBe(false);
    registry.register(new AddressingModule()); expect(registry.has("thoughts")).toBe(true);
  });
  it("uses module-specific fields, cheap voice defaults and daily scheduled probes", () => {
    const settings = characterSettingsSchema.parse({});
    expect(settings.modules.voice).toEqual({ enabled: false, budget: 800, strictness: "trim" });
    expect(settings.modules.evaluation.intervalMinutes).toBe(1440);
    expect(settings.modules.canon).not.toHaveProperty("intervalMinutes");
    expect(settings.modules.relationships).not.toHaveProperty("maxPerDay");
  });
  it("skips shadow decisions on mentions, but allows live context-boundary decisions", async () => {
    const { runtime, profiles, provider } = setup(); const generate = vi.spyOn(provider, "generateCharacterData");
    await profiles.update(guildId, { character: { context: { ...profiles.current().character!.context, enabled: true } } });
    await runtime.prepare(request()); expect(generate).not.toHaveBeenCalled();
    await profiles.update(guildId, { character: { context: { ...profiles.current().character!.context, shadow: false } } });
    await runtime.prepare(request()); expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not re-read character context for solicited tool/delivery checks after background learning", async () => {
    const { runtime, profiles, repository } = setup(() => 3000);
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, character: { enabled: true, modules: { relationships: { enabled: true } } } });
    const prepared = (await runtime.prepare(request()))!; const contribute = vi.spyOn(runtime.registry, "contribute");
    const source = await repository.ingest(record());
    await runtime.memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", slot: "relationship", now: 2000 }), [source]);
    expect(await runtime.validatePrepared(prepared)).toBe(true); expect(await runtime.validatePrepared(prepared)).toBe(true);
    expect(contribute).not.toHaveBeenCalled();
    expect(await runtime.validatePrepared({ ...prepared, request: { ...prepared.request, triggerMode: "spontaneous" } })).toBe(false);
  });
  it("trims mild voice violations even when regeneration is selected, and only regenerates severe casual formatting", async () => {
    const { runtime, profiles, provider } = setup(); const reply = vi.spyOn(provider, "reply");
    await profiles.update(guildId, { character: { enabled: true, modules: { voice: { enabled: true } } } });
    const prepared = (await runtime.prepare(request()))!;
    expect((await runtime.process(response("Great question! hi"), prepared)).text).toBe("hi");
    await runtime.process(response("## Casual list\n- hi"), prepared); expect(reply).not.toHaveBeenCalled();
    await profiles.update(guildId, { character: { modules: { voice: { strictness: "regenerate" } } } });
    const regenerated = (await runtime.prepare(request()))!;
    await runtime.process(response("Great question! hi"), regenerated); expect(reply).not.toHaveBeenCalled();
    await runtime.process(response("## Casual list\n- hi"), regenerated); expect(reply).toHaveBeenCalledTimes(1);
  });
  it("folds canon into personal extraction without adding another utility call", async () => {
    const { runtime, profiles, provider, repository, connection } = setup(() => 3000);
    await profiles.update(guildId, { character: { enabled: true, modules: { canon: { enabled: true } } } });
    const generate = vi.spyOn(provider, "generateCharacterData").mockResolvedValue({ actions: [], facts: [{ slot: "taste", statement: "likes cats", quote: "I like cats", consistent: true }] });
    vi.spyOn(provider, "reply").mockResolvedValue(response("I like cats"));
    provider.extractPersonalMemories = vi.fn(() => Promise.resolve([])); const personal = vi.spyOn(provider, "extractPersonalMemories");
    const conversation = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository),
      undefined, undefined, undefined, null, null, null, null, provider, null, null, null, runtime, () => 3000);
    try {
      await conversation.run({ ...request(), loreChunks: [], examplePool: [], sourceMessageId: "human", channelHistoryEnabled: true,
        currentEvent: { type: "message", messageId: "human", timestampMs: 3000, channelId, authorId: actorUserId, mentionedUserIds: [], replyToMessageId: null } }, (reply) => {
        reply.characterDeliveryProof = [{ messageId: "confirmed", content: reply.text }]; return Promise.resolve(reply.text);
      });
      await conversation.drain(); expect(generate).toHaveBeenCalledTimes(1); expect(personal).not.toHaveBeenCalled();
      expect((await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: 3000, moduleId: "canon" })).memories).toHaveLength(1);
    } finally { conversation.stopScheduling(); }
  });
  it("rejects a polarity contradiction stored under a different canon slot", async () => {
    const { runtime, repository, profiles, provider } = setup(() => 3000);
    await profiles.update(guildId, { character: { enabled: true, modules: { canon: { enabled: true } } } });
    const generate = vi.spyOn(provider, "generateCharacterData"); const prepared = (await runtime.prepare(request()))!;
    generate.mockResolvedValue({ actions: [], facts: [{ slot: "taste", statement: "likes cats", quote: "I like cats", consistent: true }] });
    await runtime.extractConversationMemories("hey", { ...response("I like cats"), characterDeliveryProof: [{ messageId: "one", content: "I like cats" }] }, prepared);
    generate.mockResolvedValue({ actions: [], facts: [{ slot: "opinion", statement: "dislikes cats", quote: "I dislike cats", consistent: true }] });
    await runtime.extractConversationMemories("hey", { ...response("I dislike cats"), characterDeliveryProof: [{ messageId: "two", content: "I dislike cats" }] }, prepared);
    expect((await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: 3000, moduleId: "canon" })).memories.map((memory) => memory.statement)).toEqual(["likes cats"]);
  });
  it("admits probe batches once, counts every answer and honors evaluation cooldowns", async () => {
    let now = 3000; const { runtime, provider, repository, connection } = setup(() => now); const reply = vi.spyOn(provider, "reply");
    const conversation = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository),
      undefined, undefined, undefined, null, null, null, null, provider, null, null, null, runtime, () => now);
    runtime.bindEvaluationAdmission({ run: (guild, channel, operation, cost) => conversation.runCharacterEvaluation(guild, channel,
      { ...balancedChatLimits, optionalTurnsPerWindow: 9 }, operation, cost) });
    try {
      expect((await runtime.probeMany(Array.from({ length: 7 }, () => request()))).every((answer) => answer.answer === "hey")).toBe(true);
      expect(reply).toHaveBeenCalledTimes(7); await runtime.probePair(request()); expect(reply).toHaveBeenCalledTimes(7);
      now += 30_000; await runtime.probePair(request()); expect(reply).toHaveBeenCalledTimes(9);
      now += 30_000; await runtime.probe(request()); expect(reply).toHaveBeenCalledTimes(9);
    } finally { conversation.stopScheduling(); }
  });
  it("keeps direct requests available with lightweight restraint instructions and no utility work", async () => {
    const { runtime, provider } = setup(); const prepared = await runtime.prepare(request());
    expect(prepared?.request.characterContext?.map((section) => section.moduleId)).toEqual(["participation"]); expect(prepared?.allowed).toBe(true);
    expect(provider.generateCharacterData).not.toHaveBeenCalled();
  });
  it("invalidates in-flight context when a module or dependency is disabled", async () => {
    const { runtime, profiles } = setup(); await profiles.update(guildId, { character: { enabled: true, modules: { "recall-style": { enabled: true } } } });
    const prepared = (await runtime.prepare(request()))!; expect(prepared.request.characterContext?.[0]?.moduleId).toBe("recall-style");
    const reply = await runtime.process(response(), prepared); expect(reply.characterIsCurrent?.()).toBe(true);
    await profiles.update(guildId, { character: { enabled: false } }); expect(reply.characterIsCurrent?.()).toBe(false);
    expect((await runtime.prepare(request()))?.request.characterContext?.map((section) => section.moduleId)).toEqual(["participation"]);
  });
  it("cannot enable modules through channel overrides or bypass context dependencies", () => {
    const settings = characterSettingsSchema.parse({ enabled: true, modules: { thoughts: { enabled: true }, addressing: { enabled: true } }, channelOverrides: { [channelId]: { modules: { canon: true } } } });
    const capabilities = { decision: true, context: false, memorySharing: true, continuation: true, spontaneous: true, excluded: false };
    expect(characterInactiveReason(settings, "canon", channelId, capabilities)).toBe("module_disabled");
    expect(characterInactiveReason(settings, "thoughts", channelId, capabilities)).toBe("needs_context");
  });
  it("keeps truthful disclosures out of voice repair and exempts functional output", async () => {
    const { runtime, profiles, provider } = setup(); const replySpy = vi.spyOn(provider, "reply"); await profiles.update(guildId, { character: { enabled: true, modules: { voice: { enabled: true } } } });
    const prepared = (await runtime.prepare({ ...request(), message: "are you a bot or a real person?" }))!;
    expect((await runtime.process(response("As an AI, yes I'm a bot."), prepared)).text).toContain("I'm a bot");
    await runtime.process({ ...response("Great question!"), outputOrigin: "tool" }, prepared); expect(replySpy).not.toHaveBeenCalled();
  });
  it("freezes canon ingestion and rejects canon statements about members", async () => {
    const { runtime, repository, profiles, provider } = setup(); await profiles.update(guildId, { character: { enabled: true, modules: { canon: { enabled: true, freeze: true } } } });
    await runtime.consolidate(response("I like cats"), (await runtime.prepare(request()))!); expect(provider.generateCharacterData).not.toHaveBeenCalled();
    expect(await runtime.memory.write(profiles.current(), channelId, "canon", record())).toBeNull();
    await profiles.update(guildId, { character: { modules: { canon: { freeze: false } } } });
    await expect(runtime.memory.write(profiles.current(), channelId, "canon", record())).rejects.toThrow("Canon can only describe");
    expect((await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: 2000, moduleId: "canon" })).memories).toEqual([]);
  });
  it("does not merge private and shared evidence into an impression", async () => {
    const { repository, profiles } = setup(); const memory = new CharacterMemory(repository);
    const source = await repository.ingest(record({ audience: "private", ownerUserId: actorUserId }));
    const input = record({ kind: "impression", now: 2000 });
    expect(await memory.write(profiles.current(), channelId, "relationships", input, [source])).toBeNull();
  });
  it("learns canon only from confirmed message text, never the unsent tail of a partial reply", async () => {
    const { runtime, repository, profiles, provider } = setup(() => 3000);
    await profiles.update(guildId, { character: { enabled: true, modules: { canon: { enabled: true } } } });
    vi.spyOn(provider, "generateCharacterData").mockResolvedValue({ actions: [], facts: [{ slot: "taste", statement: "likes cats", quote: "I like cats", consistent: true }] });
    const prepared = (await runtime.prepare(request()))!;
    await runtime.extractConversationMemories("hey", response("I like cats"), prepared);
    await runtime.extractConversationMemories("hey", { ...response("hello. I like cats"), characterDeliveryProof: [{ messageId: "partial", content: "hello." }] }, prepared);
    expect((await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: 3000, moduleId: "canon" })).memories).toEqual([]);
    await runtime.extractConversationMemories("hey", { ...response("I like cats"), characterDeliveryProof: [{ messageId: "confirmed", content: "I like cats" }] }, prepared);
    const rows = (await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: 3000, moduleId: "canon" })).memories;
    expect(rows).toHaveLength(1); expect((await repository.findSources(rows[0]!.id))[0]?.sourceMessageId).toBe("confirmed");
  });
  it("blocks optional delivery when a recalled impression loses its source during generation", async () => {
    const { runtime, repository, profiles } = setup(() => 3000);
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] }, character: { enabled: true, modules: { relationships: { enabled: true } } } });
    const source = await repository.ingest(record());
    await runtime.memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", slot: "relationship", now: 2000 }), [source]);
    const prepared = (await runtime.prepare({ ...request(), triggerMode: "spontaneous" }))!;
    expect(prepared.request.characterContext?.some((section) => section.moduleId === "relationships")).toBe(true);
    expect(await runtime.validatePrepared(prepared)).toBe(true);
    await repository.forget({ guildId, memoryId: source.id });
    expect(await runtime.validatePrepared(prepared)).toBe(false);
  });
  it("keeps direct and name-triggered replies deliverable when mood expires", async () => {
    let now = 3000; const { runtime, profiles } = setup(() => now);
    await profiles.update(guildId, { character: { enabled: true, modules: { mood: { enabled: true, intervalMinutes: 1 } } } });
    const prepared = (await runtime.prepare({ ...request(), message: "lol", currentEvent: { type: "message", messageId: "laugh", timestampMs: now,
      channelId, authorId: actorUserId, mentionedUserIds: [], replyToMessageId: null } }))!;
    expect(prepared.request.characterContext?.some((section) => section.moduleId === "mood")).toBe(true);
    now += 5000; expect(await runtime.validatePrepared(prepared)).toBe(true);
    now += 60_000; expect(await runtime.validatePrepared(prepared)).toBe(true);
    expect(await runtime.validatePrepared({ ...prepared, request: { ...prepared.request, triggerMode: "ambient" } })).toBe(true);
    expect(await runtime.validatePrepared({ ...prepared, request: { ...prepared.request, triggerMode: "spontaneous" } })).toBe(false);
  });
  it("keeps interview probes free of character writes and tools", async () => {
    const { runtime, repository, profiles, provider } = setup(); const replySpy = vi.spyOn(provider, "reply");
    await profiles.update(guildId, { character: { enabled: true, modules: { canon: { enabled: true }, mood: { enabled: true }, evaluation: { enabled: true } } } });
    expect(await runtime.probe({ ...request(), message: "lol, tell me about yourself" })).toBe("hey");
    expect(replySpy).toHaveBeenCalledWith(expect.objectContaining({ characterEvaluation: true, enabledTools: [], webSearchMode: "off", imageGenerationEnabled: false }));
    expect((await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: Date.now(), moduleId: "mood" })).memories).toEqual([]);
    expect((await repository.findModuleCandidates({ guildId, channelId, userId: actorUserId, now: Date.now(), moduleId: "canon" })).memories).toEqual([]);
  });
  it("builds separate non-expiring observations without a generated summary refreshing them", async () => {
    const { repository, profiles, runtime, provider } = setup(() => 3000);
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, character: { enabled: true, modules: { relationships: { enabled: true } } } });
    await repository.ingest(record({ sourceTimestampMs: 1000 }));
    await repository.ingest(record({ slot: "new-interest", statement: "recently discussed chess", sourceMessageId: "new-human", now: 2000, sourceTimestampMs: 2000 }));
    const prepared = (await runtime.prepare(request()))!;
    await runtime.consolidate(response(), prepared);
    const rows = await runtime.memory.read(profiles.current(), { guildId, channelId, userId: actorUserId, now: 3000 }, "relationships");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.structuredValue as { relationshipEvidence: { supportedAt: number } }).relationshipEvidence.supportedAt).sort()).toEqual([1000, 2000]);
    expect(rows.every((row) => row.expiresAt === null)).toBe(true);
    expect(provider.generateCharacterData).not.toHaveBeenCalled();
  });
  it("fades by human evidence age across day 89/90/91 without losing shared history", async () => {
    const { repository, profiles } = setup(); const memory = new CharacterMemory(repository);
    await profiles.update(guildId, { character: { enabled: true, modules: { fading: { enabled: true, halfLifeDays: 30 } } } });
    const day = 86_400_000;
    const old = await repository.ingest(record({ statement: "apple interest", sourceTimestampMs: 1000 }));
    const history = await repository.ingest(record({ kind: "episode", slot: "shared", statement: "shared apple joke", sourceMessageId: "event", sourceTimestampMs: 1000 }));
    const note = (source: typeof old, slot: string, now: number): Promise<Memory | null> => memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", slot, statement: source.statement, now }), [source]);
    await note(old, "old", 2000); await note(history, "history", 2000);
    for (const days of [89, 90, 91, 365]) {
      const now = 1000 + days * day;
      // Rebuilding the same note is not new human evidence.
      await note(old, "old", now);
      const rows = await memory.read(profiles.current(), { guildId, channelId, userId: actorUserId, now }, "relationships", undefined, "apple");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.statement).toBe("shared apple joke");
      expect(rows[1]!.structuredValue).toMatchObject({ relationshipEvidence: { supportedAt: 1000, type: "transient" } });
      expect(rows.every((row) => row.expiresAt === null)).toBe(true);
      await repository.deleteExpiredModuleData(guildId, now, 90);
      expect(await memory.read(profiles.current(), { guildId, channelId, userId: actorUserId, now }, "relationships")).toHaveLength(2);
    }
  });
  it("invalidates a retained impression at its source expiry and refuses bot-only evidence", async () => {
    const { repository, profiles } = setup(); const memory = new CharacterMemory(repository);
    const source = await repository.ingest(record({ expiresAt: 4000 }));
    await memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", slot: "note", now: 2000 }), [source]);
    expect(await memory.read(profiles.current(), { guildId, channelId, userId: actorUserId, now: 3999 }, "relationships")).toHaveLength(1);
    expect(await memory.read(profiles.current(), { guildId, channelId, userId: actorUserId, now: 4000 }, "relationships")).toHaveLength(0);
    const bot = await repository.ingest(record({ slot: "bot", assertedByUserId: null, source: "consolidation" }));
    expect(await memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", slot: "bot-note", now: 2000 }), [bot])).toBeNull();
  });
  it("invalidates impressions when their source changes, is forgotten, or is isolated later", async () => {
    const { repository, profiles } = setup(); const memory = new CharacterMemory(repository); const engine = new DefaultMemoryEngine(repository);
    const source = await repository.ingest(record());
    const note = await memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", topic: "character", slot: "relationship", now: 2000 }), [source]);
    expect(note).not.toBeNull(); const query = { guildId, channelId, userId: actorUserId, now: 3000 };
    expect(await memory.read(profiles.current(), query, "relationships")).toHaveLength(1);
    await profiles.update(guildId, { chatbotChannelMemoryModes: { [channelId]: "isolated" } });
    expect(await memory.read(profiles.current(), query, "relationships")).toHaveLength(0);
    await profiles.update(guildId, { chatbotChannelMemoryModes: { [channelId]: "shared" } });
    const changed = await repository.ingest(record({ now: 2500, statement: "exam postponed" }));
    expect(await memory.read(profiles.current(), query, "relationships")).toHaveLength(0);
    await engine.forget({ guildId, ownerUserId: actorUserId, memoryId: changed.id, channelId });
    expect(await memory.write(profiles.current(), channelId, "relationships", record({ kind: "impression", slot: "old-note", now: 4000 }), [source])).toBeNull();
  });
});
describe("callback delivery lifecycle", () => {
  it("remembers an unresolved date across restart, scopes source reads and retries only a new revision", async () => {
    const { repository, profiles, provider, runtime } = setup(() => 3000);
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, chatParticipation: { continuationEnabled: true },
      character: { enabled: true, modules: { callbacks: { enabled: true } } } });
    const fact = await repository.ingest(record({ statement: "exam someday", sourceQuote: "exam someday" }));
    const generate = vi.spyOn(provider, "generateCharacterData").mockResolvedValue({ date: null });
    const query = vi.spyOn(repository, "findRecallCandidates");
    const prepared = (await runtime.prepare(request()))!;
    await Promise.all([runtime.consolidate(response(), prepared), runtime.consolidate(response(), prepared)]);
    expect(callbackDateUnresolved((await repository.findById(guildId, fact.id))!)).toBe(true);
    await runtime.consolidate(response(), (await runtime.prepare(request()))!);
    const restarted = new CharacterRuntime(profiles, repository, { generateCharacterData: provider.generateCharacterData! }, provider, undefined, null, () => 4000);
    await restarted.consolidate(response(), (await restarted.prepare(request()))!);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.every(([candidate]) => candidate.subjectIds?.[0] === actorUserId)).toBe(true);
    await repository.ingest(record({ statement: "exam at a later date", sourceQuote: "exam at a later date", now: 3500 }));
    await restarted.consolidate(response(), (await restarted.prepare(request()))!);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("backs off failed normalization without permanently classifying the date as unresolved", async () => {
    let now = 3000; const { repository, profiles, provider, runtime } = setup(() => now);
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, chatParticipation: { continuationEnabled: true },
      character: { enabled: true, modules: { callbacks: { enabled: true } } } });
    const fact = await repository.ingest(record({ statement: "exam someday", sourceQuote: "exam someday" }));
    const generate = vi.spyOn(provider, "generateCharacterData").mockRejectedValue(new Error("temporary provider outage"));
    await runtime.consolidate(response(), (await runtime.prepare(request()))!);
    await runtime.consolidate(response(), (await runtime.prepare(request()))!);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(callbackDateUnresolved((await repository.findById(guildId, fact.id))!)).toBe(false);
    now += 30 * 60_000 + 1;
    await runtime.consolidate(response(), (await runtime.prepare(request()))!);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("records the original event message as the reply target, never the latest activity", async () => {
    const { repository } = setup(); const callbacks = new CharacterCallbacks(repository);
    const pending = await callbacks.plan(await repository.ingest(record({ sourceMessageId: "original-event", sourceQuote: "exam on 2026-10-15" })), 1500, channelId);
    expect(callbackState(pending!)?.eventMessageId).toBe("original-event");
  });
  it("does not send a claimed event corrected while its text is being generated", async () => {
    const { repository } = setup(); const callbacks = new CharacterCallbacks(repository);
    const pending = (await callbacks.plan(await repository.ingest(record()), 1500, channelId))!;
    const claim = (await callbacks.claim(pending, 2000))!;
    await repository.ingest(record({ now: 2500, statement: "exam cancelled" }));
    const deliver = vi.fn(() => Promise.resolve("must-not-send"));
    expect(await callbacks.send(claim, 3000, () => Promise.resolve(true), deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("atomically claims an event once and reserves a persistent daily guild quota", async () => {
    const { repository } = setup(); const callbacks = new CharacterCallbacks(repository);
    const first = (await callbacks.plan(await repository.ingest(record()), 1500, channelId))!;
    const second = (await callbacks.plan(await repository.ingest(record({ slot: "trip" })), 1500, channelId))!;
    const claims = await Promise.all([callbacks.claim(first, 2000), callbacks.claim(first, 2000), callbacks.claim(second, 2000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((item) => item !== null)!;
    expect(await callbacks.send(claim, 2000, () => Promise.resolve(true), () => Promise.resolve("discord-message"))).toBe(true);
    const restarted = new CharacterCallbacks(repository);
    expect(await restarted.claim(second, 3000)).toBeNull();
    expect(callbackState((await repository.findById(guildId, first.id))!)?.status).toBe("delivered");
  });
  it("reclaims a lease only before sending and suppresses uncertain sends after restart", async () => {
    const { repository } = setup(); const callbacks = new CharacterCallbacks(repository);
    const pending = (await callbacks.plan(await repository.ingest(record()), 1500, channelId))!;
    const claim = (await callbacks.claim(pending, 2000))!;
    const reclaimed = (await callbacks.claim((await repository.findById(guildId, pending.id))!, 63000))!;
    expect(callbackState(reclaimed)?.attemptId).not.toBe(callbackState(claim)?.attemptId);
    expect(await callbacks.send(reclaimed, 63000, () => Promise.resolve(true), () => Promise.reject(new Error("timeout")))).toBe(false);
    const uncertain = (await repository.findById(guildId, pending.id))!; expect(callbackState(uncertain)?.status).toBe("uncertain");
    expect(await new CharacterCallbacks(repository).claim(uncertain, 200000)).toBeNull();
  });
  it("retries known failures and cancels forgotten or disabled work", async () => {
    const { repository } = setup(); const callbacks = new CharacterCallbacks(repository);
    const pending = (await callbacks.plan(await repository.ingest(record()), 1500, channelId))!;
    const claim = (await callbacks.claim(pending, 2000))!;
    await callbacks.send(claim, 2000, () => Promise.resolve(true), () => Promise.reject(new CallbackKnownFailure("rate limited before send")));
    const fresh = (await repository.findById(guildId, pending.id))!; expect(callbackState(fresh)?.status).toBe("pending");
    const next = (await callbacks.claim(fresh, 150000))!;
    const send = vi.fn(() => Promise.resolve("never"));
    expect(await callbacks.send(next, 150000, () => Promise.resolve(false), send)).toBe(false); expect(send).not.toHaveBeenCalled();
    await repository.forget({ guildId, memoryId: next.id }); expect(await callbacks.send(next, 150000, () => Promise.resolve(true), send)).toBe(false);
  });
  it("preserves completed delivery on correction and refreshes pending revision on reinforcement", async () => {
    const { repository } = setup(); const callbacks = new CharacterCallbacks(repository);
    const pending = (await callbacks.plan(await repository.ingest(record()), 1500, channelId))!;
    const reinforced = await repository.ingest(record({ now: 1200 })); expect(callbackState(reinforced)?.revision).toBe(1200);
    const claim = (await callbacks.claim(reinforced, 2000))!; await callbacks.send(claim, 2000, () => Promise.resolve(true), () => Promise.resolve("sent"));
    const corrected = await repository.ingest(record({ now: 3000, statement: "exam on 2026-10-16" }));
    expect(callbackState(corrected)?.status).toBe("delivered"); expect(await callbacks.plan(corrected, 4000, channelId)).toBeNull();
    expect(pending.id).toBe(reinforced.id);
  });
});
describe("decision windows and continuation timing", () => {
  it("answers a second person's direct question without transferring the original rider plans", async () => {
    const now = 6 * 60 * 60 * 1000;
    const { runtime, provider, repository, connection } = setup(() => now);
    const decisions = vi.spyOn(provider, "generateCharacterData");
    const rider = { messageId: "rider-question", timestampMs: 1000, authorId: actorUserId, authorDisplayName: "Rider", content: "那引擎要63單套還是63/580", imageCount: 0 };
    const bot = { ...rider, messageId: "advice", timestampMs: 2000, authorId: "bot", authorDisplayName: "Bot", content: "日常騎就63單套", replyToMessageId: rider.messageId, replyToAuthorId: actorUserId, replyToAuthorDisplayName: "Rider" };
    const generation = vi.spyOn(provider, "reply").mockImplementation((modelRequest): Promise<ChatResponse> => {
      expect(modelRequest.currentUser.id).toBe("new-speaker");
      expect(buildChatContext(modelRequest)).toContain(`replyingTo="Rider" (${actorUserId}, msg=rider-question); replyTargetSameAsCurrentUser=no`);
      return Promise.resolve(response("我不跑山啦，剛剛只是回 Rider 的改車問題"));
    });
    const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository), undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => now);
    const deliver = vi.fn((reply: ChatResponse) => Promise.resolve(reply.text));
    try {
      await service.run({ ...request(), currentUser: { id: "new-speaker", displayName: "Bystander", roleNames: [] }, message: "你也要當跑山猴嗎",
        currentEvent: { type: "message", messageId: "current", authorId: "new-speaker", channelId, timestampMs: now, replyToMessageId: "advice", mentionedUserIds: [] },
        examplePool: [], loreChunks: [], triggerMode: "direct", sourceMessageId: "current", replyChain: [rider, bot] }, deliver);
      expect(generation).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce(); expect(decisions).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it.each((["bot", "continuing", "others"] as const).flatMap((addressing) =>
    (["continuation", "spontaneous"] as const).flatMap((triggerMode) =>
      [5000, 6 * 60 * 60 * 1000].map((now) => ({ addressing, triggerMode, now })))))("does not inherit another human's motorcycle exchange ($addressing / $triggerMode / $now)", async ({ addressing, triggerMode, now }) => {
    const { runtime, provider, profiles, repository, connection } = setup(() => now);
    const generation = vi.spyOn(provider, "reply");
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    const rider = { messageId: "rider", timestampMs: 1000, authorId: actorUserId, authorDisplayName: "Rider", content: "那引擎要63單套還是63/580", imageCount: 0 };
    const bot = { ...rider, messageId: "advice", timestampMs: 2000, authorId: "bot", authorDisplayName: "Bot", content: "日常騎就63單套", replyToMessageId: "rider", replyToAuthorId: actorUserId };
    const current = { ...rider, messageId: "current", timestampMs: now, authorId: "bystander", authorDisplayName: "Bystander", content: "你也要當跑山猴嗎" };
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing, motivation: 1, confidence: 1, recipientConfidence: 1, targetConfidence: 1,
      recipientEvidence: ["current"], target: "current", boundary: "earlier", opening: "clear", reaction: null, thoughts: [],
      contribution: { text: "我才不要，山路猴你自己當就好", adds: "A relevant joke", label: "relevant-joke", motivation: 1, sourceMessageId: "current", recipientId: "bystander" } });
    const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository), undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => now);
    const deliver = vi.fn(() => Promise.resolve("must not send"));
    try {
      const result = await service.run({ ...request(), message: current.content, currentUser: { id: "bystander", displayName: "Bystander", roleNames: [] },
        examplePool: [], loreChunks: [], triggerMode, sourceMessageId: "current", currentBurst: [current], channelHistory: [rider, bot], channelHistoryEnabled: true }, deliver);
      expect(result.ambientAction).toBe("ignore"); expect(deliver).not.toHaveBeenCalled(); expect(generation).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it.each(["continuation", "spontaneous"] as const)("cancels %s when another human takes over during generation", async (triggerMode) => {
    let now = 4000; const { runtime, provider, profiles, repository, connection } = setup(() => now);
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    const human = { messageId: "human", timestampMs: 1000, authorId: actorUserId, authorDisplayName: "Alice", content: "Compare these two ideas", imageCount: 0 };
    const bot = { messageId: "bot-message", timestampMs: 2000, authorId: "bot", authorDisplayName: "Bot", content: "Here is the comparison", imageCount: 0, replyToAuthorId: actorUserId, replyToMessageId: "human" };
    const current = { ...human, messageId: "current", timestampMs: 4000, content: "What about the other tradeoff?" };
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "continuing", motivation: 0.9, confidence: 0.9, recipientConfidence: 0.9, targetConfidence: 0.9, recipientEvidence: ["current"], target: "current", boundary: "earlier", opening: "clear", contribution: { text: "The second option is cheaper", adds: "A specific tradeoff", label: "specific-opinion", motivation: 0.9, sourceMessageId: "current", recipientId: actorUserId }, thoughts: [], reaction: null });
    let finish!: (reply: ChatResponse) => void;
    const pending = new Promise<ChatResponse>((resolve) => { finish = resolve; });
    const generation = vi.spyOn(provider, "reply").mockReturnValue(pending);
    const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository), undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => now);
    const deliver = vi.fn(() => Promise.resolve("sent"));
    try {
      service.observe(guildId, channelId, human); service.observe(guildId, channelId, bot);
      const turn = service.run({ ...request(), examplePool: [], loreChunks: [], triggerMode, sourceMessageId: "current", currentBurst: [current], channelHistory: [human, bot], channelHistoryEnabled: true }, deliver);
      const outcome = turn.then(() => "delivered", () => "suppressed");
      await vi.waitFor(() => expect(generation).toHaveBeenCalled());
      now = 5000; service.observe(guildId, channelId, { ...current, messageId: "new-recipient", authorId: "bob", timestampMs: now, content: "Carol, my question is for you" });
      finish(response("The second option is cheaper"));
      expect(await outcome).toBe("suppressed"); expect(deliver).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("keeps reservoir thresholds and shadow controls subordinate to the baseline labelled policy", async () => {
    const { runtime, provider, profiles } = setup(() => 4000);
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, continuationEnabled: true, spontaneousChannelIds: [channelId], spontaneousThreshold: 0.75 }, character: { enabled: true, modules: { thoughts: { enabled: true, shadow: true, threshold: 1 }, addressing: { enabled: true } } } });
    const candidate = { text: "A specific relevant joke", adds: "A joke on the current topic", label: "relevant-joke", motivation: 0.9, sourceMessageId: "current", recipientId: "group" };
    const decision = { addressing: "others", motivation: 0.9, confidence: 0.9, recipientConfidence: 0.9, targetConfidence: 0.9, recipientEvidence: ["current"], target: "current", boundary: "earlier", opening: "clear", contribution: candidate, thoughts: [candidate], reaction: null };
    vi.mocked(provider.generateCharacterData!).mockResolvedValue(decision);
    const input = { ...request(), triggerMode: "spontaneous" as const, currentBurst: [{ messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice", content: "A group joke about the current game", imageCount: 0 }] };
    expect((await runtime.prepare(input))?.allowed).toBe(true);
    await profiles.update(guildId, { character: { modules: { thoughts: { shadow: false, threshold: 0 } } } });
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ ...decision, motivation: 1, contribution: { ...candidate, label: "acknowledgment-only", motivation: 1 } });
    expect((await runtime.prepare(input))?.allowed).toBe(false);
  });
  it("suppresses an acknowledgment generated for an accepted specific contribution", async () => {
    const { runtime, provider, profiles, repository, connection } = setup(() => 4000);
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "others", motivation: 0.9, confidence: 0.9, recipientConfidence: 0.9, targetConfidence: 0.9, recipientEvidence: ["current"], target: "current", boundary: "earlier", opening: "clear", contribution: { text: "A specific relevant joke", adds: "A joke on the current topic", label: "relevant-joke", motivation: 0.9, sourceMessageId: "current", recipientId: "group" }, thoughts: [], reaction: null });
    vi.spyOn(provider, "reply").mockResolvedValue(response("okay"));
    const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository), undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => 4000);
    const current = { messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice", content: "A group joke about the current game", imageCount: 0 };
    const deliver = vi.fn(() => Promise.resolve("must not send"));
    try {
      const result = await service.run({ ...request(), examplePool: [], loreChunks: [], triggerMode: "spontaneous", sourceMessageId: "current", currentBurst: [current] }, deliver);
      expect(result.ambientAction).toBe("ignore"); expect(result.text).toBe(""); expect(deliver).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("uses the structured decision for a spontaneous reaction without calling the reply model", async () => {
    const { runtime, provider, profiles, repository, connection } = setup(() => 4000);
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "others", motivation: 0.5, confidence: 0.9,
      recipientConfidence: 0.9, targetConfidence: 0.9, recipientEvidence: ["current"], target: "current", boundary: "earlier",
      opening: "closed", contribution: { text: "", adds: "", label: "none", motivation: 0, sourceMessageId: "current", recipientId: "group" },
      thoughts: [], reaction: "🎉" });
    const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository),
      undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => 4000);
    const current = { messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice",
      content: "I got the job!", imageCount: 0 };
    const deliver = vi.fn(() => Promise.resolve("unexpected"));
    const replySpy = vi.spyOn(provider, "reply");
    try {
      const result = await service.run({ ...request(), examplePool: [], loreChunks: [], triggerMode: "spontaneous",
        sourceMessageId: "current", currentBurst: [current], historyReactionsEnabled: true }, deliver);
      expect(result).toMatchObject({ ambientAction: "ignore", reactionEmoji: "🎉", replyTargetMessageId: "current" });
      expect(deliver).not.toHaveBeenCalled(); expect(replySpy).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("enforces addressing even when character modules are disabled", async () => {
    const { runtime, provider, profiles } = setup(() => 4000);
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "bot", motivation: 0.9, boundary: "earlier", target: "current", confidence: 0.9, reaction: null, thoughts: [], recipientEvidence: ["current"], recipientConfidence: 0.9, targetConfidence: 0.9, opening: "clear", contribution: { text: "A specific observation", adds: "A new detail", label: "useful-observation", sourceMessageId: "current", recipientId: actorUserId, motivation: 0.8 } });
    const human = { messageId: "human", timestampMs: 1000, authorId: actorUserId, authorDisplayName: "Alice", content: "tell me about cats", imageCount: 0 };
    const bot = { replyToMessageId: "human", messageId: "bot-message", timestampMs: 2000, authorId: "bot", authorDisplayName: "Bot", content: "hello", imageCount: 0, replyToAuthorId: actorUserId };
    const current = { messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice", content: "你覺得呢？", imageCount: 0 };
    const input = { ...request(), triggerMode: "continuation" as const, currentBurst: [current], channelHistory: [human, bot] };
    expect((await runtime.prepare(input))?.allowed).toBe(true);
    expect((await runtime.prepare({ ...input, channelHistory: [human, bot, { ...current, messageId: "other", timestampMs: 3000, authorId: "other" }] }))?.allowed).toBe(false);
    expect((await runtime.prepare({ ...input, currentBurst: [{ ...current, replyToAuthorId: "other", replyToMessageId: "other" }] }))?.allowed).toBe(false);
  });
  it("does not turn an ordinary spontaneous acknowledgment into speech", async () => {
    const { runtime, provider, profiles } = setup(() => 4000);
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "others", motivation: 0.5, boundary: "earlier", target: "current", confidence: 0.9, reaction: null, thoughts: [], recipientEvidence: ["current"], recipientConfidence: 0.9, targetConfidence: 0.9, opening: "clear", contribution: { text: "A specific observation", adds: "A new detail", label: "acknowledgment-only", sourceMessageId: "current", recipientId: actorUserId, motivation: 0.8 } });
    const input = { ...request(), triggerMode: "spontaneous" as const, currentBurst: [{ messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice", content: "just finished dinner", imageCount: 0 }] };
    expect((await runtime.prepare(input))?.allowed).toBe(false);
  });
  it("rejects fabricated targets rather than silently repairing recipient evidence", async () => {
    const provider = { generateCharacterData: vi.fn(() => Promise.resolve({ addressing: "bot", motivation: 0.8, boundary: "bad", target: "fabricated", confidence: 0.9, reaction: null, thoughts: [] })) };
    const decision = new CharacterDecisionService(provider); const input = { personality: "test", events: [], burst: [{ messageId: "latest", timestampMs: 1000, authorId: "human", authorDisplayName: "human", content: "hello", imageCount: 0 }], botId: "bot", fixedTarget: null, gapMs: 600000, speakingShare: 0, thoughts: false };
    expect(await decision.evaluate(input)).toEqual({ status: "failed", decision: null }); expect(await decision.decide({ ...input, fixedTarget: "direct" })).toBeNull();
  });
  it("admits active continuation inside spontaneous cooldowns while bounding exchanges and the guild", async () => {
    let now = 1000; const scheduler = new ChatScheduler(() => now); const limits = { ...balancedChatLimits, continuation: true, continuationPerExchange: 2, continuationPerWindow: 3, optionalTurnsPerWindow: 4 };
    expect(await scheduler.run("guild:channel", true, limits, () => Promise.resolve("first"))).toBe("first");
    for (let index = 0; index < 2; index++) { scheduler.reserveOutput("guild:channel", "text", limits, true)!(true); now += 15000; expect(await scheduler.run("guild:channel", true, limits, () => Promise.resolve("follow-up"))).toBe("follow-up"); }
    expect(scheduler.reserveOutput("guild:channel", "text", limits, true)).toBeNull(); now += 121000;
    scheduler.reserveOutput("guild:channel", "text", limits, true)!(true);
    expect(scheduler.reserveOutput("guild:channel", "text", limits, true)).toBeNull(); scheduler.stop();
  });
  it("uses the guild calendar, including DST, and rejects invalid event dates", () => {
    expect(endOfLocalDay("2026-10-14", "Asia/Taipei")).toBe(Date.parse("2026-10-14T15:59:59.999Z"));
    expect(startOfLocalDay(Date.parse("2026-10-14T20:00:00Z"), "Asia/Taipei")).toBe(Date.parse("2026-10-14T16:00:00Z"));
    expect(endOfLocalDay("2026-03-08", "America/New_York")).toBe(Date.parse("2026-03-09T03:59:59.999Z"));
    expect(endOfLocalDay("2026-02-30", "Asia/Taipei")).toBeNull();
  });
});
