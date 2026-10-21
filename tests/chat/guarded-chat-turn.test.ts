import type { ExampleExchangeSelector } from "../../src/application/chat/example-exchange-selector.js";
import type { PersonaLoreSelector } from "../../src/application/chat/persona-lore-selector.js";
import { characterInternals } from "../helpers/character-runtime-internals.js";
import { fixtureMemoryIngest } from "../helpers/approved-memory-fixture.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatConversationService, type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatRequest, ChatResponse, ChatProvider } from "../../src/application/chat/chat-provider.js";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { buildChatContext, buildChatInstructions } from "../../src/infrastructure/chat/chat-structured-output.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";
import { decisionProposal, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";
import { contextualProposal } from "../helpers/contextual-decision-fixtures.js";
import { balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import { GuardedBackgroundContext } from "../../src/application/context/guarded-background-context.js";
import { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import { DiceRollTool } from "../../src/application/chat/tools/dice-tool.js";
import { hashContent } from "../../src/application/assets/content-hash.js";
import { memoryRelationPayload } from "../../src/application/memory/memory-relation-provenance.js";
import type { MemoryRelation } from "../../src/application/memory/memory.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { guardedToolResourcePort } from "../../src/application/chat/guarded-tool-gateway.js";
import { conversationConfiguration } from "../../src/application/context/conversation-configuration.js";
import { GuardedConfigurationContext } from "../../src/application/context/guarded-configuration-context.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";

const channelId = "500000000000000001";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(now = 5000, originalAuthor = "alice", contextual = false, nativeWebSearchSupported = false, tools: ChatToolRegistry | null = null, imageGenerationSupported = false, customization: UserCustomizationStore | null = null, utility: ChatProvider | null = null, enrichment?: { examples: ExampleExchangeSelector; lore: PersonaLoreSelector }): Promise<{
  service: ChatConversationService; fixture: ReturnType<typeof guardedFixture>; input: ChatConversationInput;
  reply: ReturnType<typeof vi.fn<(request: ChatRequest) => Promise<ChatResponse>>>;
  engine: DefaultMemoryEngine; runtime: CharacterRuntime; state: SqliteChatStateStore;
  decision: { generateCharacterData: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>> };
  records: Record<string, unknown>[];
  profiles: ReturnType<typeof memoryProvider>;
}> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-turn-")));
  const repository = new SqliteMemoryRepository(connection.database); const state = new SqliteChatStateStore(connection.database);
  const document = freshDocument(); document.features.chatbot = true; document.features.channelHistory = true; document.channels.chatbot = [channelId];
  const profiles = memoryProvider(document);
  await profiles.update(guildId, { character: { context: { ...profiles.current().character!.context, enabled: true, retrievalMode: "eligible_count" } },
    chatParticipation: { flowVersion: contextual ? "contextual_v1" : "legacy", continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
  const reply = vi.fn((_request: ChatRequest) => Promise.resolve(decisionResponse({ text: "The carburetor needs a richer mixture at full throttle.", ambientAction: "reply", responseIntent: "answer" })));
  const decision = { generateCharacterData: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(decisionProposal({
    recipientEvidence: ["current"], target: "current", boundary: "earlier",
    contribution: { text: "A carburetor answer", adds: "Mixture adjustment", label: "answer", motivation: 0.95, sourceMessageId: "current", recipientId: "alice" },
  }))) };
  const { logger, records } = captureDiagnosticLogger();
  const runtime = new CharacterRuntime(profiles, repository, null, { reply }, decision, null, () => now, logger);
  const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => true);
  const service = new ChatConversationService({ reply, nativeWebSearchSupported, applicationToolsSupported: true, imageGenerationSupported }, state, engine, undefined, enrichment?.examples, enrichment?.lore, customization, null, tools, logger, utility, null, null, null, runtime, () => now);
  cleanups.push(async () => { service.stopScheduling(); await service.drain(); runtime.stop(); connection.close(); });
  const fixture = guardedFixture(guardedEvent("question", 1000, "Explain the carburetor mixture adjustment", originalAuthor), { guildId, channelId });
  const previous = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
  fixture.sources.set("answer", { event: { ...guardedEvent("answer", 2000, "Which throttle range?", "bot", { replyToMessageId: "question" }), channelId }, origin: "chat", provenance: previous.provenance("Which throttle range?") });
  fixture.add(guardedEvent("current", 4000, "@bot", "alice", { replyToMessageId: "answer" })); fixture.port.sourceMessageId = "current";
  fixture.port.actorId = "alice";
  const input: ChatConversationInput = { guildId, channelId, sourceMessageId: "current", personality: "A dry, playful mechanic",
    configurationContext: await configurationFixture("A dry, playful mechanic", "persona", () => true, guildId),
    personaDrift: "SECRET_DRIFT", loreChunks: [], examplePool: [], currentUser: { id: "alice", displayName: "alice", roleNames: [] }, mentionedUsers: [],
    message: "UNTRUSTED_SYNTHETIC_INPUT", replyChain: [], channelHistory: [], images: [], includeSources: false,
    webSearchMode: "auto", imageGenerationEnabled: true, toolsEnabled: true, triggerMode: "direct", botUserId: "bot",
    guardedContextPort: fixture.port, guardedContextPolicy: { count: 40, budget: 12000 }, channelHistoryEnabled: true };
  return { service, fixture, input, reply, engine, runtime, state, decision, records, profiles };
}

describe("guarded turn acceptance", () => {
  it("preserves authored facts used by preflight when reply semantic enrichment returns no lore", async () => {
    const enrichment = { examples: { select: vi.fn<ExampleExchangeSelector["select"]>().mockResolvedValue([]) },
      lore: { select: vi.fn<PersonaLoreSelector["select"]>().mockResolvedValue([]) } };
    const { service, input, fixture, decision, reply } = await setup(5000, "alice", true, false, null, false, null, null, enrichment);
    fixture.sources.get("current")!.event.content = "carburetor";
    const fact = { heading: "carburetor", text: "The carburetor needs the approved mixture.", embedding: null };
    input.configurationContext = await GuardedConfigurationContext.open({ kind: "persona", guildId, ownerUserId: null },
      { text: "A dry mechanic", loreChunks: [fact] }, () => true);
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "followup", referent: "context_linked", intent: "answer",
      action: "reply", linkKey: "speaker_1", recipientEvidence: ["current"] }));
    await service.run({ ...input, triggerMode: "continuation" }, (response) => Promise.resolve(response.text));
    expect(JSON.stringify(decision.generateCharacterData.mock.calls)).toContain(fact.text);
    expect(reply.mock.calls[0]![0].personaLore).toContainEqual({ heading: fact.heading, text: fact.text });
  });
  it.each(["silent", "react", "reply"] as const)("runs reply-only semantic retrieval after a contextual %s decision", async (action) => {
    let decided = false;
    const examples = { select: vi.fn<ExampleExchangeSelector["select"]>(() => { expect(decided).toBe(true); return Promise.resolve([]); }) };
    const lore = { select: vi.fn<PersonaLoreSelector["select"]>(() => { expect(decided).toBe(true); return Promise.resolve([]); }) };
    const { service, input, decision, reply } = await setup(5000, "alice", true, false, null, false, null, null, { examples, lore });
    decision.generateCharacterData.mockImplementation(() => {
      decided = true;
      return Promise.resolve(contextualProposal({ relationship: "followup", referent: "context_linked", intent: action === "react" ? "social" : action === "silent" ? "abstain" : "answer",
        action, linkKey: "speaker_1", recipientEvidence: ["current"], reaction: action === "react" ? "👍" : null,
        ...(action !== "reply" ? { contribution: null } : {}) }));
    });
    await service.run({ ...input, triggerMode: "continuation", historyReactionsEnabled: true }, (response) => Promise.resolve(response.text));
    expect(decision.generateCharacterData).toHaveBeenCalledOnce();
    expect(examples.select).toHaveBeenCalledTimes(action === "reply" ? 1 : 0);
    expect(lore.select).toHaveBeenCalledTimes(action === "reply" ? 1 : 0);
    expect(reply).toHaveBeenCalledTimes(action === "reply" ? 1 : 0);
  });
  it.each(["eligible", "restricted", "edited", "model_failure"] as const)("compacts only registered reply ancestry and handles optional failures: %s", async (scenario) => {
    const summarizeReplyChainOverflow = vi.fn<NonNullable<ChatProvider["summarizeReplyChainOverflow"]>>();
    const { service, input, fixture, reply } = await setup(5000, "alice", false, false, null, false, null, { reply: vi.fn(), summarizeReplyChainOverflow });
    for (let index = 0; index < 25; index++) fixture.add(guardedEvent(`ancestor-${index}`, 100 + index, `AUTHORIZED_ANCESTOR_${index}`, "alice", { replyToMessageId: index ? `ancestor-${index - 1}` : null }));
    fixture.sources.get("current")!.event.replyToMessageId = "ancestor-24";
    input.replyChainOverflow = [{ authorId: "hidden", authorDisplayName: "hidden", content: "UNREGISTERED_OVERFLOW", messageId: "fake", imageCount: 0, timestampMs: 0 }];
    if (scenario === "restricted") fixture.denied.add("ancestor-2");
    summarizeReplyChainOverflow.mockImplementation((hops) => {
      expect(hops).toHaveLength(scenario === "restricted" ? 2 : 5);
      expect(JSON.stringify(hops)).not.toContain("UNREGISTERED_OVERFLOW");
      if (scenario === "edited") fixture.sources.get("ancestor-0")!.event.content = "changed during summary";
      if (scenario === "model_failure") return Promise.reject(new Error("model unavailable"));
      return Promise.resolve("AUTHORIZED_RECAP");
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const call = service.run(input, send);
    if (scenario === "edited") await expect(call).rejects.toBeInstanceOf(SocialOutputSuppressed);
    else { await call; expect(reply.mock.calls[0]![0].replyChainSummary).toBe(scenario === "model_failure" ? null : "AUTHORIZED_RECAP"); }
    expect(send).toHaveBeenCalledTimes(scenario === "edited" ? 0 : 1);
  });
  it.each(["eligible", "changed"] as const)("uses owner-scoped style preferences and rechecks before delivery: %s", async (scenario) => {
    let value = "- Tone: concise OWNER_STYLE";
    const load = vi.fn<UserCustomizationStore["load"]>(() => Promise.resolve(value));
    const store: UserCustomizationStore = { initialize: vi.fn(), load, save: vi.fn(), clear: vi.fn() };
    const { service, input, reply } = await setup(5000, "alice", false, false, null, false, store);
    reply.mockImplementation((request) => {
      expect(request.userCustomization).toBe(value);
      expect(buildChatInstructions(request, "Safety instructions")).toContain("OWNER_STYLE");
      if (scenario === "changed") value = "- Tone: changed";
      return Promise.resolve(decisionResponse());
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const call = service.run(input, send);
    if (scenario === "changed") await expect(call).rejects.toBeInstanceOf(SocialOutputSuppressed);
    else { const result = await call;
      expect(result.contextProvenance?.resources).toContainEqual(expect.objectContaining({ kind: "user_preferences", id: "alice" }));
      expect(JSON.stringify(result.contextProvenance)).not.toContain("OWNER_STYLE");
    }
    expect(send).toHaveBeenCalledTimes(scenario === "eligible" ? 1 : 0);
    expect(load.mock.calls.every(([scope, owner]) => scope === guildId && owner === "alice")).toBe(true);
  });
  it.each(["eligible", "changed"] as const)("uses registered persona material and rejects changes before delivery: %s", async (scenario) => {
    const { service, input, fixture, reply, decision } = await setup(5000, "alice", true); let current = true;
    fixture.sources.get("current")!.event.content = "Tell me about the forest";
    fixture.sources.get("current")!.event.replyToMessageId = null;
    input.configurationContext = await GuardedConfigurationContext.open({ kind: "persona", guildId, ownerUserId: null }, {
      text: "AUTHORIZED_CORE", loreChunks: [{ heading: "forest", text: "AUTHORIZED_LORE", embedding: null }],
      examples: [{ tags: "forest", user: "AUTHORIZED_EXAMPLE", character: "AUTHORED_VOICE" }],
    }, () => current);
    input.personality = "UNREGISTERED_PERSONA";
    input.loreChunks = [{ heading: "forest", text: "UNREGISTERED_LORE", embedding: null }];
    input.examplePool = [{ tags: "forest", user: "UNREGISTERED_EXAMPLE", character: "hidden" }];
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "group", intent: "contribute", referent: "self_contained", linkKey: null, recipientEvidence: ["current"] }));
    reply.mockImplementation((request) => {
      const payload = buildChatInstructions(request, "Safety instructions") + buildChatContext(request);
      expect(payload).toContain("AUTHORIZED_LORE"); expect(payload).toContain("AUTHORIZED_EXAMPLE");
      expect(request.personality).toBe("AUTHORIZED_CORE"); expect(payload).not.toContain("UNREGISTERED_");
      if (scenario === "changed") current = false;
      return Promise.resolve(decisionResponse());
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const call = service.run({ ...input, triggerMode: "spontaneous" }, send);
    if (scenario === "changed") await expect(call).rejects.toBeInstanceOf(SocialOutputSuppressed); else await call;
    expect(send).toHaveBeenCalledTimes(scenario === "eligible" ? 1 : 0);
    expect(JSON.stringify(decision.generateCharacterData.mock.calls)).toContain("AUTHORIZED_LORE");
  });
  it.each(["verified", "unproven", "revoked"] as const)("independently projects alias evidence for decision and generation: %s", async (scenario) => {
    const { service, input, fixture, engine, reply, decision } = await setup(5000, "alice", true);
    fixture.sources.get("question")!.event.content = "Call me OldAlice. I like apples.";
    fixture.sources.get("current")!.event.content = "OldAlice likes what?";
    fixture.sources.get("current")!.event.replyToMessageId = null;
    const source = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
    const row = (await engine.ingest(fixtureMemoryIngest({ guildId, channelId, channelMode: "shared", assertedByUserId: "alice", sourceMessageId: "question", source: "live", now: 3000,
      ...(scenario === "unproven" ? {} : { context: source }), proposals: [{ action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit", statement: "likes apples", channelScoped: true, observedSubjectNames: ["OldAlice"] }] }))).ingested[0]!;
    vi.spyOn(engine, "recall").mockResolvedValue({ memories: [], causalChains: [], aliasSources: [row], aliasCandidates: [{ alias: "FORGED_ALIAS", subjectIds: ["unknown"] }] });
    if (scenario === "revoked") fixture.denied.add("question");
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "group", intent: "contribute", referent: "self_contained", linkKey: null, recipientEvidence: ["current"] }));
    await service.run({ ...input, triggerMode: "spontaneous" }, (response) => Promise.resolve(response.text));
    const aliases = reply.mock.calls[0]![0].aliasCandidates ?? [];
    expect(aliases).toEqual(scenario === "verified" ? [{ alias: "oldalice", subjectIds: ["alice"] }] : []);
    expect(JSON.stringify(decision.generateCharacterData.mock.calls).includes("oldalice")).toBe(scenario === "verified");
    expect(JSON.stringify(aliases)).not.toContain("FORGED_ALIAS");
  });
  it.each(["verified", "unproven", "actor_revoked"] as const)("independently authorizes graph context before exposing a recalled chain: %s", async (scenario) => {
    const { service, input, fixture, engine, reply } = await setup();
    fixture.actors.set("bob", { id: "bob", displayName: "Bob", roleNames: [] });
    const source = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
    await source.participants(["bob"]);
    const relation: MemoryRelation = { id: "edge", guildId, channelId, fromSubjectType: "member", fromSubjectId: "alice", toSubjectType: "member", toSubjectId: "bob",
      predicate: "owes", kind: "consequence", supportingMemoryId: null, isolationChannelId: null, createdAt: 3000 };
    relation.contextProvenance = scenario === "unproven" ? null : source.provenance(memoryRelationPayload(relation)!, "relation");
    if (scenario === "actor_revoked") fixture.actors.delete("bob");
    vi.spyOn(engine, "recall").mockResolvedValue({ memories: [], causalChains: [{ fromSubjectType: "member", fromSubjectId: "alice", toSubjectType: "member", toSubjectId: "bob",
      predicate: "owes", sourceRelation: relation }] });
    await service.run(input, (response) => Promise.resolve(response.text));
    const chains = reply.mock.calls[0]![0].causalChains;
    expect(chains).toHaveLength(scenario === "verified" ? 1 : 0);
    expect(JSON.stringify(chains)).not.toContain("contextProvenance"); expect(JSON.stringify(chains)).not.toContain("sourceRelation");
  });

  it.each([true, false])("resolves an explicitly mentioned eligible profile even without that person's history: %s", async (allowed) => {
    const { service, input, fixture, reply } = await setup();
    const bobId = "500000000000000002";
    fixture.sources.get("current")!.event.content = `<@${bobId}> what is their birthday?`;
    if (allowed) fixture.actors.set(bobId, { id: bobId, displayName: "Bob", roleNames: [] });
    await service.run(input,
      (response) => Promise.resolve(response.text));
    expect(reply.mock.calls[0]![0].mentionedUsers.map((user) => user.id)).toEqual(allowed ? [bobId] : []);
  });
  it.each(["eligible", "revoked"] as const)("shares source-verified learned state with decision and generation: %s", async (scenario) => {
    const { service, input, reply, fixture, runtime, profiles, decision } = await setup(5000, "alice", true);
    fixture.sources.get("current")!.event.content = "What should I adjust in this engine?";
    fixture.sources.get("current")!.event.replyToMessageId = null;
    await profiles.update(guildId, { character: { enabled: true, modules: { mood: { enabled: true } } } });
    const sourceContext = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
    const written = await characterInternals(runtime).memory.write(profiles.current(), channelId, "mood", { kind: "state", audience: "channel", ownerUserId: null,
      channelId, isolationChannelId: channelId, subjectType: "persona", subjectId: "character", topic: "character.mood", slot: "fast-mood", statement: "SOURCE_VERIFIED_MOOD",
      status: "active", source: "consolidation", importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 3000,
      sourceMessageId: "question", sourceChannelId: channelId, assertedByUserId: null, structuredValue: { personaHash: hashContent(input.personality) }, sourceContext });
    expect(written).not.toBeNull();
    if (scenario === "revoked") fixture.denied.add("question");
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "group", intent: "contribute", referent: "self_contained", linkKey: null, recipientEvidence: ["current"] }));
    await service.run({ ...input, triggerMode: "spontaneous" }, (response) => Promise.resolve(response.text));
    const request = reply.mock.calls[0]![0];
    expect(JSON.stringify(request.characterContext).includes("SOURCE_VERIFIED_MOOD")).toBe(scenario === "eligible");
    expect(JSON.stringify(decision.generateCharacterData.mock.calls).includes("SOURCE_VERIFIED_MOOD")).toBe(scenario === "eligible");
  });
  it.each(["eligible", "changed"] as const)("checks generated images at the final delivery boundary without speculative previews: %s", async (scenario) => {
    const { service, input, reply, fixture } = await setup(5000, "alice", false, false, null, true);
    const image = { data: Buffer.from("image"), contentType: "image/png" as const, filename: "picture.png" };
    reply.mockImplementation((request) => {
      expect(request.imageGenerationEnabled).toBe(true);
      if (scenario === "changed") fixture.denied.add("question");
      return Promise.resolve(decisionResponse({ generatedImages: [image] }));
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text)); const onImagePreview = vi.fn();
    const pending = service.run(input, send, { onImagePreview });
    if (scenario === "changed") { await expect(pending).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(send).not.toHaveBeenCalled(); }
    else { const response = await pending; expect(response.generatedImages).toEqual([image]); expect(send).toHaveBeenCalledOnce(); }
    expect(onImagePreview).not.toHaveBeenCalled();
  });
  it("offers only guarded tools and preserves their functional execution in final decision", async () => {
    const { service, input, reply } = await setup(5000, "alice", false, false, new ChatToolRegistry([new DiceRollTool()]));
    reply.mockImplementation(async (request) => {
      expect(request.enabledTools?.map((tool) => tool.name)).toEqual(["roll_dice"]);
      const result = await request.enabledTools![0]!.execute({ count: 1, sides: 6 }, { guildId, channelId, currentUser: request.currentUser,
        channelMode: "shared", channelIsNsfw: false, isOwner: false, music: null, pendingGeneratedImages: [] });
      expect(JSON.parse(result.content)).toMatchObject({ count: 1, sides: 6 });
      expect(request.functionalToolExecuted).toBe(true);
      return decisionResponse();
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    await service.run(input, send); expect(send).toHaveBeenCalledOnce();
  });
  it.each(["eligible", "changed"] as const)("uses lease-authorized image input and suppresses stale image output: %s", async (scenario) => {
    const { service, fixture, input, reply } = await setup();
    fixture.sources.get("current")!.assets = [{ id: "image", contentType: "image/png", size: 10 }];
    fixture.port.loadAsset = (): Promise<string> => Promise.resolve("data:image/png;base64,aGVsbG8=");
    reply.mockImplementation((request) => {
      expect(request.images).toEqual([{ dataUrl: "data:image/png;base64,aGVsbG8=", source: "current_message", sourceMessageId: "current", sourceIndex: 0 }]);
      expect(JSON.stringify(request.images)).not.toContain("UNTRUSTED_IMAGE");
      if (scenario === "changed") fixture.sources.get("current")!.assets = [];
      return Promise.resolve(decisionResponse());
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const pending = service.run({ ...input, imageInputEnabled: true, images: [{ dataUrl: "UNTRUSTED_IMAGE", source: "current_message", sourceIndex: 0 }] }, send);
    if (scenario === "changed") { await expect(pending).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(send).not.toHaveBeenCalled(); }
    else { await pending; expect(send).toHaveBeenCalledOnce(); }
  });

  it("persists only source-grounded human memory proposals with a registered claim proof", async () => {
    const { service, input, engine, fixture, reply } = await setup();
    fixture.sources.get("current")!.event.content = "I like green apples";
    fixture.sources.get("current")!.event.replyToMessageId = null;
    reply.mockResolvedValue(decisionResponse({ userMemoryActions: [
      { action: "upsert", subjectUserId: "alice", topic: "preference", slot: "food.fruit", statement: "likes green apples", sourceQuote: "I like green apples" },
      { action: "upsert", subjectUserId: "alice", topic: "preference", slot: "food.secret", statement: "UNSUPPORTED_FACT", sourceQuote: "NOT_IN_ANY_SOURCE" },
    ] }));
    await service.run(input, (response) => Promise.resolve(response.text));
    const stored = await engine.recall({ guildId, channelId, userId: "alice", message: "apples", recentHistory: [], subjectIds: ["alice"], now: 6000 });
    expect(stored.memories.map((record) => record.statement)).toEqual(["likes green apples"]);
    expect(stored.memories[0]?.contextProvenance?.purpose).toBe("memory_claim");
  });

  it.each(["eligible", "revoked"] as const)("shares proven memory with decision and generation without exposing revoked facts: %s", async (scenario) => {
    const { service, input, engine, fixture, reply, decision } = await setup(5000, "alice", true);
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "group", intent: "contribute", referent: "self_contained", linkKey: null, recipientEvidence: ["current"] }));
    const original = fixture.sources.get("question")!.event;
    original.content = "I like green apples";
    fixture.sources.get("current")!.event.content = "What fruit do I like?";
    fixture.sources.get("current")!.event.replyToMessageId = null;
    const context = await GuardedBackgroundContext.open("summary", [{ id: original.messageId, guildId, channelId, authorId: original.authorId,
      authorDisplayName: original.authorDisplayName, content: original.content, createdAt: original.timestampMs }], { readBatch: vi.fn(), validateBatch: () => Promise.resolve(true) }, () => true);
    await engine.ingest(fixtureMemoryIngest({ guildId, channelId, channelMode: "shared", context, source: "consolidation", sourceMessageId: "batch",
      assertedByUserId: "alice", sourceTimestampMs: original.timestampMs, now: 3000, proposals: [{ action: "upsert", audience: "private", kind: "preference",
        ownerUserId: "alice", subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit", statement: "likes green apples", channelScoped: true }] }));
    if (scenario === "revoked") fixture.denied.add("question");
    await service.run({ ...input, triggerMode: "spontaneous" }, (response) => Promise.resolve(response.text));
    const request = reply.mock.calls[0]![0];
    expect(request.guildKnowledge.map((record) => record.statement)).toEqual(scenario === "eligible" ? ["likes green apples"] : []);
    const decisions = JSON.stringify(decision.generateCharacterData.mock.calls);
    if (scenario === "eligible") expect(decisions).toContain("likes green apples");
    else expect(decisions).not.toContain("green apples");
  });

  it.each(["enabled", "disabled", "unsupported", "shadow"] as const)("resolves native web search without enabling unguarded application tools: %s", async (scenario) => {
    const { service, input, reply, records } = await setup(5000, "alice", false, scenario !== "unsupported");
    reply.mockImplementation((request) => {
      expect(request.webSearchMode).toBe(scenario === "enabled" ? "auto" : "off");
      expect(request.enabledTools).toEqual([]); expect(request.images).toEqual([]);
      expect(request.imageGenerationEnabled).toBe(false); expect(request.includeSources).toBe(true);
      return Promise.resolve(decisionResponse({ webSearchUsed: true, sources: [
        { title: "Public source", url: "https://example.com/source" },
        { title: "Unsafe", url: "http://127.0.0.1/secret" },
        { title: "Private Discord", url: "https://discord.com/channels/1/2/3" },
      ] }));
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const response = await service.run({ ...input, includeSources: true, shadowMode: scenario === "shadow",
      webSearchMode: scenario === "disabled" ? "off" : "auto" }, send);
    expect(reply).toHaveBeenCalledOnce();
    expect(response.webSearchUsed).toBe(scenario === "enabled");
    expect(response.sources).toEqual(scenario === "enabled" ? [{ title: "Public source", url: "https://example.com/source" }] : []);
    if (scenario === "enabled") {
      expect(response.contextProvenance?.publicWeb?.citationHashes).toHaveLength(1);
      expect(JSON.stringify(response.contextProvenance)).not.toContain("https://example.com");
    }
    expect(send).toHaveBeenCalledTimes(scenario === "shadow" ? 0 : 1);
    expect(records).toContainEqual(expect.objectContaining({ event: "chat.capabilities.resolved",
      webSearchEffective: scenario === "enabled" ? "auto" : "off" }));
  });

  it("cancels searched output when its protected context changes", async () => {
    const { service, input, reply, fixture } = await setup(5000, "alice", false, true);
    reply.mockImplementation(() => {
      fixture.denied.add("question");
      return Promise.resolve(decisionResponse({ webSearchUsed: true }));
    });
    const send = vi.fn(() => Promise.resolve("sent"));
    await expect(service.run(input, send)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(send).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight turn when the web-search setting changes", async () => {
    const { service, input, reply, profiles } = await setup(5000, "alice", false, true);
    reply.mockImplementation(async (request) => {
      await profiles.update(guildId, { chatbotWebSearchMode: profiles.current().chat.webSearchMode === "auto" ? "off" : "auto" });
      await request.beforeModelAttempt?.();
      return decisionResponse();
    });
    const send = vi.fn(() => Promise.resolve("sent"));
    await expect(service.run(input, send)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(send).not.toHaveBeenCalled();
  });

  it("excludes unverified session quotations and cached bot episodes through the active lease", async () => {
    const { service, input, reply, state, records } = await setup();
    await state.commitSuccessfulExchange({ guildId, userId: "alice", channelId, sourceMessageId: "unverified",
      userMessage: "old question", assistantMessage: "PROTECTED_SESSION_QUOTATION", actions: [], now: 3000 });
    service.observe(guildId, channelId, guardedEvent("cached-bot", 3000, "UNVERIFIABLE_EPISODE_TEXT", "bot", { channelId }));
    reply.mockImplementation((request) => {
      const prompt = buildChatContext(request);
      expect(request.recentHistory).toEqual([]);
      expect(prompt).not.toContain("PROTECTED_SESSION"); expect(prompt).not.toContain("UNVERIFIABLE_EPISODE");
      return Promise.resolve(decisionResponse());
    });
    await service.run(input, (response) => Promise.resolve(response.text));
    expect(reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(records)).not.toContain("PROTECTED_SESSION");
  });
  it.each(["reply", "react", "silent", "failed", "invalid_link", "low_confidence", "actor_revoked", "source_changed", "budget", "shadow"] as const)("enforces reaction preflight through generation and effects: %s", async (scenario) => {
    const { service, fixture, input, reply, decision } = await setup(5000, "alice", true);
    fixture.port.sourceMessageId = "answer"; fixture.port.actorId = null;
    const currentEvent = { type: "reaction_snapshot" as const, channelId, targetMessageId: "answer", targetAuthorId: "bot", observedAt: 5000,
      complete: true, exactReactionTimes: "unknown" as const, reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice"] }] };
    const proposal = contextualProposal({ relationship: "group", intent: "contribute", linkKey: "reaction", recipientEvidence: ["answer"] });
    if (scenario === "react") { proposal.action = "react"; proposal.intent = "social"; proposal.reaction = "👍"; proposal.contribution = null; }
    if (scenario === "silent") { proposal.action = "silent"; proposal.contribution = null; proposal.linkKey = null; proposal.recipientEvidence = []; }
    if (scenario === "invalid_link") proposal.linkKey = "speaker_1";
    if (scenario === "low_confidence") proposal.recipientConfidence = 0.2;
    if (scenario === "actor_revoked") fixture.actors.delete("alice");
    decision.generateCharacterData.mockImplementation(() => {
      if (scenario === "failed") return Promise.reject(new Error("Unavailable"));
      if (scenario === "source_changed") fixture.denied.add("question");
      return Promise.resolve(proposal);
    });
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text)); const effects = vi.fn(() => Promise.resolve());
    const pending = service.run({ ...input, sourceMessageId: "answer", triggerMode: "reaction", currentEvent,
      historyReactionsEnabled: true, afterDecision: effects, shadowMode: scenario === "shadow",
      ...(scenario === "budget" ? { activityLimits: { ...balancedChatLimits, textPerWindow: 0 } } : {}) }, send);
    if (scenario === "actor_revoked" || scenario === "source_changed") await expect(pending).rejects.toBeInstanceOf(SocialOutputSuppressed);
    else await pending;
    expect(decision.generateCharacterData).toHaveBeenCalledTimes(scenario === "actor_revoked" ? 0 : 1);
    expect(reply).toHaveBeenCalledTimes(scenario === "reply" || scenario === "shadow" ? 1 : 0);
    expect(send).toHaveBeenCalledTimes(scenario === "reply" ? 1 : 0);
    expect(effects).toHaveBeenCalledTimes(scenario === "reply" || scenario === "react" ? 1 : 0);
  });
  it.each(["missing_guard", "disabled_context", "legacy_retrieval"] as const)("does not let a contextual turn fall back around its required stages: %s", async (scenario) => {
    const { service, input, profiles, reply, decision, records } = await setup(5000, "alice", true);
    if (scenario === "missing_guard") delete input.guardedContextPort;
    else await profiles.update(guildId, { character: { context: { ...profiles.current().character!.context,
      ...(scenario === "disabled_context" ? { enabled: false } : { retrievalMode: "legacy" as const }) } } });
    await expect(service.run(input, () => Promise.resolve("unexpected"))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled(); expect(decision.generateCharacterData).not.toHaveBeenCalled();
    expect(records).toContainEqual(expect.objectContaining({ event: "chat.turn.plan", state: "blocked" }));
    expect(records.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
  });
  it("never exposes reactions to effect callbacks after invalid generation evidence", async () => {
    const { service, fixture, input, reply, decision } = await setup(5000, "alice", true);
    fixture.add(guardedEvent("current", 4000, "然後呢"));
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ recipientEvidence: ["question", "answer", "current"] }));
    reply.mockResolvedValue(decisionResponse({ referentSourceIds: ["not-authorized"], reactionEmoji: "👍", historyReactions: [{ messageId: "question", emoji: "🎉" }] }));
    const send = vi.fn(() => Promise.resolve("sent")); const afterDecision = vi.fn(() => Promise.resolve());
    const response = await service.run({ ...input, triggerMode: "spontaneous", afterDecision }, send);
    expect(response.conversationDecision).toMatchObject({ status: "failed", decision: { action: "silent" } });
    expect(response.reactionEmoji).toBeNull(); expect(response.historyReactions).toEqual([]);
    expect(send).not.toHaveBeenCalled(); expect(afterDecision).not.toHaveBeenCalled();
  });
  it.each(["followup", "group", "low_confidence", "social_generation"] as const)("distinguishes requested confirmation from unsolicited contribution: %s", async (scenario) => {
    const { service, fixture, input, reply, decision } = await setup(5000, "alice", true);
    fixture.add(guardedEvent("current", 4000, "第二個"));
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: scenario === "group" ? "group" : "followup",
      recipientEvidence: ["question", "answer", "current"], recipientConfidence: scenario === "low_confidence" ? 0.2 : 0.95,
      contribution: { text: "", adds: "", label: "acknowledgment-only", motivation: 0.1 } }));
    reply.mockResolvedValue(decisionResponse({ text: "Okay", responseIntent: scenario === "social_generation" ? "social" : "answer" }));
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const result = await service.run({ ...input, triggerMode: "spontaneous" }, send);
    expect(reply).toHaveBeenCalledTimes(scenario === "followup" || scenario === "social_generation" ? 1 : 0);
    expect(send).toHaveBeenCalledTimes(scenario === "followup" ? 1 : 0);
    if (scenario === "followup") {
      expect(result.conversationDecision?.decision).toMatchObject({ action: "reply", intent: "answer", participationKind: "continuation" });
      const instructions = reply.mock.calls[0]![0].characterContext?.filter((entry) => entry.moduleId === "participation").map((entry) => entry.text).join(" ");
      expect(instructions).toContain("grounded follow-up");
      expect(instructions).not.toContain("Serve only this accepted contribution");
    }
    if (scenario === "social_generation") expect(result.conversationDecision?.decision.reasonCode).toBe("substantive_requires_answer");
  });
  it.each(["ordinary_clause", "known_recipient"] as const)("requires recipient evidence rather than an arbitrary comma prefix: %s", async (scenario) => {
    const { service, fixture, input, reply, decision } = await setup(963000, "bob", true);
    fixture.add(guardedEvent("current", 962000, scenario === "ordinary_clause" ? "我是在修你ㄟ，你剛剛壞掉了不回他，跟生日沒關係" : "bob，你剛剛選了哪個？"));
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ linkKey: "reference_1", recipientEvidence: ["question", "answer", "current"] }));
    const result = await service.run({ ...input, triggerMode: "spontaneous" }, (response) => Promise.resolve(response.text));
    expect(reply).toHaveBeenCalledTimes(scenario === "ordinary_clause" ? 1 : 0);
    if (scenario === "known_recipient") expect(result.conversationDecision?.decision.reasonCode).toBe("addressed_elsewhere");
  });
  it("suppresses generation for an unresolved referent after reading authorized context", async () => {
    const { service, fixture, input, reply, decision, records } = await setup(5000, "alice", true);
    fixture.add(guardedEvent("current", 4000, "好了嗎"));
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "group", referent: "unresolved", recipientEvidence: ["question", "answer", "current"] }));
    const result = await service.run({ ...input, triggerMode: "spontaneous" }, (response) => Promise.resolve(response.text));
    expect(decision.generateCharacterData).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(result.conversationDecision?.decision).toMatchObject({ action: "silent", reasonCode: "referent_unresolved" });
    expect(records).toContainEqual(expect.objectContaining({ event: "model.decision.attempt", wireRevision: 4 }));
    expect(records).toContainEqual(expect.objectContaining({ event: "chat.decision.proposed", action: "reply", referent: "unresolved", relationship: "group" }));
    expect(records).toContainEqual(expect.objectContaining({ event: "chat.decision.resolved", action: "silent", reason: "referent_unresolved" }));
  });
  it.each(["state", "generation"] as const)("ends a stalled contextual %s phase and prevents late delivery", async (phase) => {
    const { service, input, fixture, state, reply, decision, records } = await setup(5000, "alice", true);
    fixture.add(guardedEvent("current", 4000, "好了嗎"));
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ recipientEvidence: ["question", "answer", "current"] }));
    const savedState = await state.load(guildId, "alice", channelId, 5000);
    let release = (): void => undefined;
    const load = phase === "state" ? vi.spyOn(state, "load").mockImplementation(() => new Promise((resolve) => { release = (): void => resolve(savedState); })) : null;
    if (phase === "generation") reply.mockImplementation(() => new Promise((resolve) => { release = (): void => resolve(decisionResponse()); }));
    vi.useFakeTimers();
    const send = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    const pending = service.run({ ...input, triggerMode: "spontaneous" }, send);
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(30001); await rejected;
    expect(records.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
    expect(records).toContainEqual(expect.objectContaining({ event: "chat.turn.deadline" }));
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    load?.mockRestore(); reply.mockImplementation(() => Promise.resolve(decisionResponse()));
    await service.run(input, send);
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(["followup", "group"] as const)("keeps continuation-only policy after contextual classification: %s", async (relationship) => {
    const { service, fixture, input, reply, decision, profiles } = await setup(5000, "alice", true);
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: false } });
    fixture.add(guardedEvent("current", 4000, "然後呢"));
    decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship, recipientEvidence: ["question", "answer", "current"] }));
    const result = await service.run({ ...input, triggerMode: "continuation" }, (response) => Promise.resolve(response.text));
    expect(reply).toHaveBeenCalledTimes(relationship === "followup" ? 1 : 0);
    if (relationship === "group") expect(result.conversationDecision?.decision.reasonCode).toBe("spontaneous_disabled");
  });
  it.each(["followup", "group", "recipient_correction", "social_reaction", "substantive_reaction", "silence", "elsewhere", "unclear", "low_confidence"] as const)("applies contextual policy after neutral admission: %s", async (scenario) => {
    const { service, fixture, input, reply, decision, records } = await setup(5000, "alice", true);
    fixture.add(guardedEvent("current", 4000, scenario === "recipient_correction" ? "我不是在問你" : scenario === "social_reaction" ? "謝謝!" : "好了嗎"));
    const proposal = contextualProposal({ recipientEvidence: ["question", "answer", "current"] });
    if (scenario === "group") proposal.relationship = "group";
    if (scenario === "recipient_correction") proposal.relationship = "group";
    if (scenario === "social_reaction") { proposal.action = "react"; proposal.intent = "social"; proposal.reaction = "👍"; proposal.contribution = null; }
    if (scenario === "substantive_reaction") { proposal.action = "react"; proposal.reaction = "👍"; }
    if (scenario === "silence") { proposal.action = "silent"; proposal.contribution = null; proposal.recipientEvidence = []; }
    if (scenario === "elsewhere" || scenario === "unclear") proposal.relationship = scenario;
    if (scenario === "low_confidence") proposal.recipientConfidence = 0.2;
    decision.generateCharacterData.mockResolvedValue(proposal);
    const result = await service.run({ ...input, triggerMode: "spontaneous", historyReactionsEnabled: true }, (response) => Promise.resolve(response.text));
    expect(reply).toHaveBeenCalledTimes(scenario === "followup" || scenario === "group" ? 1 : 0);
    if (scenario === "social_reaction") expect(result.reactionEmoji).toBe("👍");
    if (scenario === "followup" || scenario === "group") expect(records).toContainEqual(expect.objectContaining({
      event: "chat.output.reservation", status: "committed", continuation: scenario === "followup",
    }));
    expect(records.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
  });
  it.each(["accepted", "inactive_boundary", "cross_participant", "missing_evidence", "other_recipient", "private_source", "low_confidence", "decision_failed"] as const)("handles a sixteen-minute correction with guarded evidence: %s", async (scenario) => {
    const { service, fixture, input, reply, runtime, decision, records } = await setup(963000, scenario === "cross_participant" ? "bob" : "alice");
    const correction = guardedEvent("current", 962000, "我是在修你ㄟ 你剛剛壞掉了不回他\n跟大番薯沒關西");
    fixture.add(correction);
    // The local episode window is empty, as after restart or a long gap.
    expect(runtime.couldBeAddressed(guildId, channelId, correction, [], "bot")).toBe(true);
    const proposal = decisionProposal({ recipientEvidence: ["question", "answer", "current"] });
    if (scenario === "inactive_boundary") proposal.boundary = "invalid-legacy-boundary";
    if (scenario === "missing_evidence") proposal.recipientEvidence = ["current"];
    if (scenario === "low_confidence") proposal.recipientConfidence = 0.2;
    if (scenario === "other_recipient") fixture.add({ ...correction, replyToMessageId: "question" });
    if (scenario === "private_source") fixture.denied.add("question");
    if (scenario === "decision_failed") decision.generateCharacterData.mockRejectedValue(new Error("unavailable"));
    else decision.generateCharacterData.mockResolvedValue(proposal);
    await service.run({ ...input, triggerMode: "continuation" }, (response) => Promise.resolve(response.text)).catch((error: unknown) => {
      expect(error).toBeInstanceOf(SocialOutputSuppressed);
    });
    if (scenario === "accepted" || scenario === "inactive_boundary") expect(reply).toHaveBeenCalledOnce();
    else expect(reply).not.toHaveBeenCalled();
    const completed = records.filter((record) => record.event === "chat.turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ sourceMessageId: "current", triggerMode: "continuation" });
    if (scenario === "inactive_boundary") expect(completed[0]).toMatchObject({ outcome: "text_delivered", textDeliveryConfirmed: true });
  });
  it("skips redundant saved-session reads when both sides already exist in guarded history", async () => {
    const { service, fixture, input, reply, state } = await setup();
    await state.commitSuccessfulExchange({ guildId, userId: "alice", channelId, sourceMessageId: "question",
      userMessage: "Explain the carburetor mixture adjustment", assistantMessage: "Which throttle range?", assistantMessageIds: ["answer"],
      contextProvenance: fixture.sources.get("answer")!.provenance, actions: [], now: 3000 });
    const sessions = vi.spyOn(GuardedConversationContext.prototype, "sessions");
    try {
      await service.run(input, (response) => Promise.resolve(response.text));
      expect(sessions).toHaveBeenCalledExactlyOnceWith([]);
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]![0].recentHistory).toEqual([]);
      expect(buildChatContext(reply.mock.calls[0]![0])).toContain("Which throttle range?");
    } finally { sessions.mockRestore(); }
  });
  it("rejects a mismatched source frame before model work", async () => {
    const { service, input, fixture, reply } = await setup();
    fixture.port.channelId = "another-channel";
    await expect(service.run(input, (response) => Promise.resolve(response.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });

  it("clears primary history even if durable context cleanup throws synchronously", async () => {
    const { service, state } = await setup();
    await state.commitSuccessfulExchange({ guildId, userId: "alice", channelId, userMessage: "question", assistantMessage: "answer", actions: [], now: 5000 });
    service.bindContextForgetRecorder(() => { throw new Error("storage unavailable"); });
    await expect(service.forgetConversation(guildId, "alice")).rejects.toThrow("durable context invalidation failed");
    expect((await state.load(guildId, "alice", channelId, 5001)).exchanges).toEqual([]);
  });

  it.each(([
    ["direct_mention", "direct"], ["explicit_reply", "direct"], ["bare_ping", "direct"], ["name_address", "ambient"],
    ["implicit_followup", "continuation"], ["group_conversation", "spontaneous"], ["reaction", "reaction"],
  ] as const).flatMap(([interactionMode, triggerMode]) => [false, true].map((contextual) => ({ interactionMode, triggerMode, contextual }))))("retains the authorized conversation for $interactionMode ($triggerMode, contextual=$contextual)", async ({ interactionMode, triggerMode, contextual }) => {
    const { service, fixture, input, reply, decision } = await setup(5000, "alice", contextual);
    if (contextual && (triggerMode === "continuation" || triggerMode === "spontaneous")) decision.generateCharacterData.mockResolvedValue(contextualProposal({ recipientEvidence: ["question", "answer", "current"] }));
    if (triggerMode === "reaction") { fixture.port.sourceMessageId = "answer"; fixture.port.actorId = null;
      decision.generateCharacterData.mockResolvedValue(contextualProposal({ relationship: "group", intent: "contribute", linkKey: "reaction", recipientEvidence: ["answer"] }));
      input.currentEvent = { type: "reaction_snapshot", channelId, targetMessageId: "answer", targetAuthorId: "bot", observedAt: 5000,
        complete: true, exactReactionTimes: "unknown", reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice"] }] };
      input.sourceMessageId = "answer";
    }
    const sent = vi.fn((response: ChatResponse) => { response.characterDeliveryProof = [{ messageId: "delivered", content: response.text }]; return Promise.resolve(response.text); });
    const response = await service.run({ ...input, interactionMode, triggerMode,
    }, sent);
    expect(reply).toHaveBeenCalledOnce(); expect(sent).toHaveBeenCalledOnce();
    expect(decision.generateCharacterData).toHaveBeenCalledTimes(triggerMode === "continuation" || triggerMode === "spontaneous" || triggerMode === "reaction" ? 1 : 0);
    const request = reply.mock.calls[0]![0];
    expect([...request.replyChain, ...request.channelHistory].map((event) => event.messageId)).toContain("question");
    expect(buildChatContext(request)).toContain("Explain the carburetor");
    expect(buildChatContext(request)).not.toContain("SECRET_DRIFT"); expect(buildChatContext(request)).not.toContain("UNTRUSTED_SYNTHETIC");
    expect(response.contextProvenance?.coverage).toBe("complete");
  });

  it("keeps bare pings contextual and lets personality produce a playful social reply", async () => {
    const { service, input, reply } = await setup();
    reply.mockImplementation((request) => {
      expect(request.characterContext?.some((entry) => entry.text.includes("earlier substantive request"))).toBe(true);
      expect(request.personality).toContain("playful");
      return Promise.resolve(decisionResponse({ text: "You rang? The carburetor is still waiting.", responseIntent: "social", ambientAction: "reply" }));
    });
    const result = await service.run({ ...input, interactionMode: "bare_ping", allowSilentDirect: true }, (response) => Promise.resolve(response.text));
    expect(result.text).toContain("You rang?"); expect(result.conversationDecision?.decision.action).toBe("reply");
  });

  it("treats an unlinked bare ping as a reference to an older eligible request", async () => {
    const { service, fixture, input, reply } = await setup();
    fixture.sources.get("current")!.event.replyToMessageId = null;
    fixture.sources.delete("answer");
    fixture.sources.get("question")!.event.timestampMs = 0;
    reply.mockImplementation((request) => {
      expect(request.message).toBe("@bot"); expect(request.replyChain).toEqual([]);
      expect(request.channelHistory.map((event) => event.messageId)).toContain("question");
      return Promise.resolve(decisionResponse({ text: "For the earlier carburetor question, adjust the mixture first.",
        responseIntent: "answer", referentSourceIds: ["question"], ambientAction: "reply" }));
    });
    const result = await service.run({ ...input, interactionMode: "bare_ping" }, (response) => Promise.resolve(response.text));
    expect(result.conversationDecision?.decision.referentSourceIds).toEqual(["question"]);
  });

  it("keeps repeated-social-ping protection after contextual interpretation", async () => {
    const { service, fixture, input, reply } = await setup();
    reply.mockResolvedValue(decisionResponse({ text: "You rang?", responseIntent: "social", ambientAction: "reply" }));
    const sent = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    await service.run(input, sent);
    fixture.add(guardedEvent("second", 5000, "@bot")); fixture.port.sourceMessageId = "second";
    const second = await service.run({ ...input, sourceMessageId: "second" }, sent);
    expect(reply).toHaveBeenCalledTimes(2); expect(sent).toHaveBeenCalledOnce();
    expect(second.conversationDecision).toMatchObject({ status: "denied", decision: { reasonCode: "duplicate_ping", action: "silent" } });
  });

  it("never sends unreadable reaction-target content to the model", async () => {
    const { service, fixture, input, reply } = await setup();
    fixture.sources.get("answer")!.provenance = null;
    fixture.sources.get("answer")!.event.content = "PROTECTED_LEGACY_TARGET";
    fixture.port.sourceMessageId = "answer"; fixture.port.actorId = null;
    await expect(service.run({ ...input, triggerMode: "reaction", sourceMessageId: "answer", message: "PROTECTED_LEGACY_TARGET",
      currentEvent: { type: "reaction_snapshot", channelId, targetMessageId: "answer", targetAuthorId: "bot", observedAt: 5000,
        complete: true, exactReactionTimes: "unknown", reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice"] }] },
    }, (response) => Promise.resolve(response.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });

  it("treats unavailable memory as an omission and gives character contributors the registered source context", async () => {
    const { service, input, engine, runtime } = await setup();
    const recall = vi.spyOn(engine, "recall").mockRejectedValue(new Error("SECRET_MEMORY"));
    const contribute = vi.spyOn(characterInternals(runtime).registry, "contribute");
    await service.run({ ...input, interactionMode: "direct_mention" }, (response) => Promise.resolve(response.text));
    expect(recall.mock.calls[0]?.[0].context).toBeInstanceOf(GuardedConversationContext);
    expect(contribute.mock.calls[0]?.[0].request.contextLease).toBeInstanceOf(GuardedConversationContext);
  });

  it("rechecks source access after generation and prevents all delivery", async () => {
    const { service, fixture, input, reply } = await setup();
    reply.mockImplementation(() => { fixture.denied.add("question"); return Promise.resolve(decisionResponse()); });
    const send = vi.fn(() => Promise.resolve("sent"));
    await expect(service.run(input, send)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks source access before provider retries", async () => {
    const { service, fixture, input, reply } = await setup();
    const external = vi.fn();
    reply.mockImplementation(async (request) => {
      fixture.denied.add("question"); await request.beforeModelAttempt?.(); external(); return decisionResponse();
    });
    await expect(service.run(input, (response) => Promise.resolve(response.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(external).not.toHaveBeenCalled();
  });

  it("records a complete session that can be revalidated on the next turn", async () => {
    const { service, fixture, input, state } = await setup();
    await service.run(input, (response) => {
      const text = response.text;
      fixture.sources.set("delivered", { event: { ...guardedEvent("delivered", 4500, text, "bot", { replyToMessageId: "current" }), channelId },
        origin: "chat", provenance: response.contextLease!.provenance(text) });
      response.characterDeliveryProof = [{ messageId: "delivered", content: text }]; return Promise.resolve(text);
    });
    const stored = await state.load(guildId, "alice", channelId, 5000);
    expect(stored.exchanges[0]?.contextProvenance?.coverage).toBe("complete");
    fixture.add(guardedEvent("next", 5000, "next question")); fixture.port.sourceMessageId = "next";
    const configuration = await conversationConfiguration(guildId, "alice", input.configurationContext, null);
    const next = await GuardedConversationContext.open(guardedToolResourcePort(fixture.port, null, { currentUser: input.currentUser, channelMode: "shared", channelIsNsfw: false, isOwner: false }, undefined, configuration), { count: 40, budget: 12000, burstIds: [] });
    expect(await next.sessions(stored.exchanges)).toHaveLength(1);
  });
});
