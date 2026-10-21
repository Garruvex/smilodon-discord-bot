import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterMemory, type CharacterMemoryWrite } from "../../src/application/chat/character-memory.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { memoryClaimPayload, memoryClaimProof } from "../../src/application/memory/memory-claim-provenance.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";
import { GuardedBackgroundContext } from "../../src/application/context/guarded-background-context.js";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { decisionResponse } from "../helpers/conversation-decision-fixtures.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("guarded learned character sources", () => {
  it.each(["verified", "legacy", "revoked", "wrong_channel"] as const)("keeps background reflection inside original batch authority: %s", async (scenario) => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "background-character-"))); cleanups.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database);
    const document = freshDocument(); document.features.chatbot = true; document.features.channelHistory = true; document.chat.sharedMemoryEnabled = true;
    document.character.enabled = true; document.character.modules.relationships.enabled = true;
    const profiles = memoryProvider(document); let allowed = true;
    const message = { id: "source", guildId, channelId: "channel", authorId: "alice", authorDisplayName: "Alice", content: "I enjoy gardening", createdAt: 1000 };
    const reader = { readBatch: vi.fn(), validateBatch: (): Promise<boolean> => Promise.resolve(allowed) };
    const context = await GuardedBackgroundContext.open("summary", [message], reader, () => true);
    const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => true);
    const result = await engine.ingest({ guildId, channelId: "channel", channelMode: "shared", ...(scenario === "legacy" ? {} : { context }),
      assertedByUserId: "alice", sourceMessageId: "source", sourceTimestampMs: 1000, source: "consolidation", now: 2000,
      proposals: [{ action: "upsert", audience: "guild", kind: "preference", ownerUserId: null, subjectType: "member", subjectId: "alice",
        topic: "preference", slot: "hobby.gardening", statement: "enjoys gardening", channelScoped: true, sourceQuote: "I enjoy gardening" }] });
    expect(result.ingested).toHaveLength(1);
    const reply = vi.fn(() => Promise.resolve(decisionResponse()));
    const runtime = new CharacterRuntime(profiles, repository, null, { reply }, null, null, () => 3000);
    cleanups.push(() => runtime.stop());
    const authority = scenario === "wrong_channel" ? await GuardedBackgroundContext.open("summary", [{ ...message, channelId: "other" }], reader, () => true) : context;
    if (scenario === "revoked") allowed = false;
    const work = runtime.afterMemoryConsolidation(authority, ["alice", "not_in_batch"]);
    if (scenario === "revoked") await expect(work).rejects.toBeInstanceOf(SocialOutputSuppressed); else await work;
    const rows = await repository.findModuleCandidates({ guildId, channelId: "channel", userId: "alice", moduleId: "relationships", now: 3000 });
    expect(rows.memories).toHaveLength(scenario === "verified" ? 1 : 0);
    if (scenario === "verified") expect(memoryClaimProof(rows.memories[0]!.contextProvenance, rows.memories[0]!)).not.toBeNull();
    expect(reply).not.toHaveBeenCalled();
  });
  it.each(["verified", "legacy", "edited_metadata", "revoked_source"] as const)("admits only source-backed character state: %s", async (scenario) => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-character-"))); cleanups.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database); const memory = new CharacterMemory(repository);
    const document = freshDocument(); document.features.chatbot = true; const profile = memoryProvider(document).current();
    const fixture = guardedFixture(guardedEvent("current", 4000, "hello"), { guildId, channelId: "channel" });
    fixture.add(guardedEvent("old", 1000, "thanks"));
    const sourceContext = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 4000, burstIds: [] });
    const input: CharacterMemoryWrite = { kind: "state", audience: "channel", ownerUserId: null, channelId: "channel", isolationChannelId: null,
      subjectType: "persona", subjectId: "character", topic: "character.mood", slot: "fast-mood", statement: "amused", status: "active",
      source: "consolidation", importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 5000,
      sourceMessageId: "current", sourceChannelId: "channel", assertedByUserId: null, structuredValue: { personaHash: "persona", setting: { b: 2, a: 1 } },
      ...(scenario === "legacy" ? {} : { sourceContext }) };
    const written = await memory.write(profile, "channel", "mood", input);
    expect(written).not.toBeNull();
    if (scenario !== "legacy") {
      expect(written!.contextProvenance?.purpose).toBe("memory_claim");
      expect(memoryClaimProof(written!.contextProvenance, written!)).not.toBeNull();
      expect(memoryClaimPayload({ ...written!, structuredValue: { ...(written!.structuredValue as object), setting: { a: 1, b: 2 } } })).toBe(memoryClaimPayload(written!));
    }
    if (scenario === "edited_metadata") await repository.compareAndSetStructuredValue({ guildId, memoryId: written!.id, updatedAt: written!.updatedAt,
      expected: written!.structuredValue, value: { personaHash: "persona", SECRET_UNPROVEN: "hidden" } });
    if (scenario === "revoked_source") fixture.denied.add("old");
    const next = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 4000, burstIds: [] });
    const rows = await memory.read(profile, { guildId, channelId: "channel", userId: "alice", now: 6000, sourceContext: next }, "mood", "persona");
    expect(rows.map((row) => row.statement)).toEqual(scenario === "verified" ? ["amused"] : []);
  });
});
