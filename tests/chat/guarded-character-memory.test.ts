import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CharacterMemory, type CharacterMemoryWrite } from "../../src/application/chat/character-memory.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { memoryClaimPayload, memoryClaimProof } from "../../src/application/memory/memory-claim-provenance.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("guarded learned character sources", () => {
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
