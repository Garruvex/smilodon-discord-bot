import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import { guardModelTransport } from "../../src/application/context/guarded-model-transport.js";
import { createGuardedMemoryEngine } from "../../src/application/context/guarded-memory-gateway.js";
import { authoredCharacterResource } from "../../src/application/context/authored-character-configuration.js";
import { memoryClaimPayload } from "../../src/application/memory/memory-claim-provenance.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { hashContent } from "../../src/application/assets/content-hash.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import { memoryProvider, freshDocument, guildId } from "../helpers/settings-fixtures.js";
import { characterInternals } from "../helpers/character-runtime-internals.js";
import type { Memory, RepositoryIngestInput } from "../../src/application/memory/memory.js";
import type { ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";

const channelId = "channel"; const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
async function fixture(verified = false): Promise<{
  repository: SqliteMemoryRepository; runtime: CharacterRuntime; original: Memory; persona: Awaited<ReturnType<typeof configurationFixture>>;
  source: ReturnType<typeof guardedFixture>; context: () => Promise<GuardedConversationContext>; run: () => Promise<ChatRequest>;
}> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "authored-character-"))); close.push(() => connection.close());
  const repository = new SqliteMemoryRepository(connection.database); const document = freshDocument(); document.features.chatbot = true; document.features.channelHistory = true;
  const profiles = memoryProvider(document);
  await profiles.update(guildId, { character: { enabled: true, modules: { canon: { enabled: true } } } });
  const source = guardedFixture(guardedEvent("original", 1000, "old source", "alice"), { guildId, channelId }); source.port.persist = true; source.port.shareMemory = true;
  const originalContext = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  const material: RepositoryIngestInput = { guildId, moduleId: "canon", kind: "fact", audience: "channel", ownerUserId: null, channelId, isolationChannelId: channelId,
    subjectType: "persona", subjectId: "character", topic: "character.canon", slot: "taste", statement: "PRIVATE_LEGACY_TEXT", status: "active", source: "consolidation",
    importance: 1, embedding: [1, 0], embeddingModel: "old", expiresAt: null, now: 1000, sourceMessageId: "original", sourceChannelId: channelId,
    assertedByUserId: "alice", structuredValue: { personaHash: "old", dependencies: [], discardedLegacyText: "PRIVATE_LEGACY_METADATA" } };
  const original = await repository.ingest({ ...material, contextProvenance: verified ? originalContext.provenance(memoryClaimPayload(material), "memory_claim") : null });
  const persona = await configurationFixture("Authored persona", "persona", () => true, guildId);
  let captured!: ChatRequest;
  const provider = guardModelTransport({ reply: (request: ChatRequest): Promise<ChatResponse> => { captured = request; return Promise.resolve(decisionResponse()); } });
  const runtime = new CharacterRuntime(profiles, repository, null, provider, null, null, () => 3000); close.push(() => runtime.stop());
  runtime.bindCallbackPersona(() => Promise.resolve(persona));
  source.add(guardedEvent("current", 2000, "hello", "alice")); source.port.sourceMessageId = "current";
  source.port.resource = (key): Promise<string | null> => key.kind === "persona_configuration" ? Promise.resolve(persona.fingerprint) : key.kind === "character_configuration" ? runtime.readCharacterConfiguration(guildId, channelId, key.id) : Promise.resolve(null);
  const context = (): Promise<GuardedConversationContext> => GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), createGuardedMemoryEngine(repository),
    undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => 3000);
  close.push(() => service.stopScheduling());
  const run = async (): Promise<ChatRequest> => {
    await service.run({ ...decisionRequest({ guildId, channelId, channelHistory: [], interaction: "direct_mention" }), sourceMessageId: "current", guardedContextPort: source.port,
      configurationContext: persona, examplePool: [], loreChunks: [], channelHistoryEnabled: true }, (reply) => Promise.resolve(reply.text));
    await service.drain(); return captured;
  };
  return { repository, runtime, original, persona, source, context, run };
}
describe("explicit authored character ledger configuration", () => {
  it("edits a legacy entry into a verifiable authored revision without promoting its old text, metadata or embedding", async () => {
    const { runtime, repository, original, run } = await fixture();
    expect(await runtime.manageCanon(guildId, "admin", channelId, "edit", original.id, "likes oranges")).toBe("canon entry updated.");
    const rows = await repository.findModuleCandidates({ guildId, channelId, userId: "alice", moduleId: "canon", now: 3000 }); const revised = rows.memories[0]!;
    expect(revised.id).not.toBe(original.id); expect(revised.contextProvenance?.dependencies).toEqual([]);
    expect(revised.embedding).toBeNull(); expect(revised.structuredValue).not.toHaveProperty("discardedLegacyText");
    const resource = revised.contextProvenance!.resources!.find((entry) => entry.kind === "character_configuration")!;
    expect(await authoredCharacterResource(repository, guildId, channelId, resource.id, 3000)).not.toBeNull();
    expect(await runtime.readCharacterConfiguration(guildId, channelId, resource.id)).not.toBeNull();
    const request = await run(); expect(JSON.stringify(request.characterContext)).toContain("likes oranges"); expect(JSON.stringify(request)).not.toContain("PRIVATE_LEGACY");
  });
  it("preserves verified human dependencies and rejects the edited entry after source revocation", async () => {
    const { runtime, repository, original, source, context, persona } = await fixture(true);
    await runtime.manageCanon(guildId, "admin", channelId, "edit", original.id, "likes oranges");
    const read = async (): Promise<readonly Memory[]> => characterInternals(runtime).memory.read(memoryProvider().current(), { guildId, channelId, userId: "alice", now: 3000, sourceContext: await context() }, "canon", hashContent(persona.material.text));
    expect(await read()).toHaveLength(1); source.denied.add("original"); expect(await read()).toEqual([]);
    expect((await repository.findById(guildId, original.id))?.status).toBe("superseded");
  });
  it.each(["edit", "delete", "clear"])("invalidates an in-flight lease after an authored %s", async (operation) => {
    const { runtime, original, repository, context } = await fixture();
    await runtime.manageCanon(guildId, "admin", channelId, "edit", original.id, "likes oranges");
    const row = (await repository.findModuleCandidates({ guildId, channelId, userId: "alice", moduleId: "canon", now: 3000 })).memories[0]!;
    const lease = await context(); expect(await lease.characterMemories([row], true, 3000)).toHaveLength(1);
    await runtime.manageCanon(guildId, "admin", channelId, operation, row.id, operation === "edit" ? "likes pears" : null);
    expect(await lease.validate()).toBe(false);
  });
  it("requires a matching administrator source event even if a stored proof/marker is present", async () => {
    const { runtime, original, repository, context } = await fixture(); await runtime.manageCanon(guildId, "admin", channelId, "edit", original.id, "likes oranges");
    const row = (await repository.findModuleCandidates({ guildId, channelId, userId: "alice", moduleId: "canon", now: 3000 })).memories[0]!;
    const sources = repository.findSources.bind(repository); repository.findSources = (id): ReturnType<typeof sources> => sources(id).then((records) => records.filter((record) => record.source !== "administrator"));
    expect(await (await context()).characterMemories([row], true, 3000)).toEqual([]);
  });
  it("keeps authored revisions inside their original destination", async () => {
    const { runtime, original } = await fixture();
    expect(await runtime.manageCanon(guildId, "admin", "elsewhere", "edit", original.id, "likes oranges")).not.toBe("canon entry updated.");
    expect(await runtime.manageCanon(guildId, "admin", channelId, "unexpected", original.id, "likes oranges")).toBe("Unknown ledger operation.");
  });
});
