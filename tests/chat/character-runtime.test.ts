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
import { characterInactiveReason, characterSettingsSchema } from "../../src/application/chat/character-settings.js";
import { ChatScheduler, balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { RepositoryIngestInput } from "../../src/application/memory/memory.js";
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
  const repository = new SqliteMemoryRepository(connection.database); const doc = freshDocument(); doc.features.chatbot = true; doc.features.channelHistory = true;
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
  it("leaves default turns unchanged and performs no utility work", async () => {
    const { runtime, provider } = setup(); const prepared = await runtime.prepare(request());
    expect(prepared?.request.characterContext).toEqual([]); expect(prepared?.allowed).toBe(true);
    expect(provider.generateCharacterData).not.toHaveBeenCalled();
  });
  it("invalidates in-flight context when a module or dependency is disabled", async () => {
    const { runtime, profiles } = setup(); await profiles.update(guildId, { character: { enabled: true, modules: { "recall-style": { enabled: true } } } });
    const prepared = (await runtime.prepare(request()))!; expect(prepared.request.characterContext?.[0]?.moduleId).toBe("recall-style");
    const reply = await runtime.process(response(), prepared); expect(reply.characterIsCurrent?.()).toBe(true);
    await profiles.update(guildId, { character: { enabled: false } }); expect(reply.characterIsCurrent?.()).toBe(false);
    expect((await runtime.prepare(request()))?.request.characterContext).toEqual([]);
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
    await profiles.update(guildId, { chatbotSharedMemoryEnabled: true, character: { enabled: true, modules: { relationships: { enabled: true } } } });
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
  it("enforces addressing even when character modules are disabled", async () => {
    const { runtime, provider } = setup(() => 4000);
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "bot", motivation: 0.9, boundary: "earlier", target: "current", confidence: 0.9, reaction: null, thoughts: [] });
    const bot = { messageId: "bot-message", timestampMs: 2000, authorId: "bot", authorDisplayName: "Bot", content: "hello", imageCount: 0, replyToAuthorId: actorUserId };
    const current = { messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice", content: "你覺得呢？", imageCount: 0 };
    const input = { ...request(), triggerMode: "continuation" as const, currentBurst: [current], channelHistory: [bot] };
    expect((await runtime.prepare(input))?.allowed).toBe(true);
    expect((await runtime.prepare({ ...input, channelHistory: [bot, { ...current, messageId: "other", timestampMs: 3000, authorId: "other" }] }))?.allowed).toBe(false);
    expect((await runtime.prepare({ ...input, currentBurst: [{ ...current, replyToAuthorId: "other", replyToMessageId: "other" }] }))?.allowed).toBe(false);
  });
  it("does not turn an ordinary spontaneous acknowledgment into speech", async () => {
    const { runtime, provider } = setup(() => 4000);
    vi.mocked(provider.generateCharacterData!).mockResolvedValue({ addressing: "others", motivation: 0.5, boundary: "earlier", target: "current", confidence: 0.9, reaction: null, thoughts: [] });
    const input = { ...request(), triggerMode: "spontaneous" as const, currentBurst: [{ messageId: "current", timestampMs: 4000, authorId: actorUserId, authorDisplayName: "Alice", content: "just finished dinner", imageCount: 0 }] };
    expect((await runtime.prepare(input))?.allowed).toBe(false);
  });
  it("pins direct targets and falls back to latest on a fabricated target", async () => {
    const provider = { generateCharacterData: vi.fn(() => Promise.resolve({ addressing: "bot", motivation: 0.8, boundary: "bad", target: "fabricated", confidence: 0.9, reaction: null, thoughts: [] })) };
    const decision = new CharacterDecisionService(provider); const input = { personality: "test", events: [], burst: [{ messageId: "latest", timestampMs: 1000, authorId: "human", authorDisplayName: "human", content: "hello", imageCount: 0 }], botId: "bot", fixedTarget: null, gapMs: 600000, speakingShare: 0, thoughts: false };
    expect((await decision.decide(input))?.target).toBe("latest"); expect((await decision.decide({ ...input, fixedTarget: "direct" }))?.target).toBe("direct");
  });
  it("admits active continuation inside spontaneous cooldowns while bounding exchanges and the guild", async () => {
    let now = 1000; const scheduler = new ChatScheduler(() => now); const limits = { ...balancedChatLimits, continuation: true, continuationPerExchange: 2, continuationPerWindow: 3, optionalTurnsPerWindow: 4 };
    expect(await scheduler.run("guild:channel", true, limits, () => Promise.resolve("first"))).toBe("first");
    for (let index = 0; index < 2; index++) { scheduler.reserveOutput("guild:channel", "text", limits, true)!(true); now += 4000; expect(await scheduler.run("guild:channel", true, limits, () => Promise.resolve("follow-up"))).toBe("follow-up"); }
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
