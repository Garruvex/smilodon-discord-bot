import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

describe("persisted context subject invalidation", () => {
  it("removes dependent exchanges and proofs across owners while preserving unrelated guilds and legacy records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "context-subject-"));
    const connection = createSqliteDatabaseConnection(directory);
    try {
      const state = new SqliteChatStateStore(connection.database);
      const origins = new SqliteMessageOriginStore(connection.database);
      const fixture = guardedFixture(guardedEvent("question", 1, "question", "bob")); fixture.port.actorId = "bob";
      const context = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
      const proof = context.provenance("answer")!;
      expect(proof.audience.userId).toBeNull();
      for (const guildId of ["guild", "other-guild"]) {
        const scoped = { ...proof, audience: { ...proof.audience, guildId }, dependencies: proof.dependencies.map((dependency) => ({ ...dependency, guildId })) };
        for (const userId of ["alice", "carol"]) await state.commitSuccessfulExchange({ guildId, userId, channelId: "channel",
          userMessage: "question", assistantMessage: "answer", contextProvenance: scoped, actions: [], now: 10 });
        await origins.record({ guildId, channelId: "channel", messageId: `${guildId}-dependent`, origin: "chat", sourceMessageId: "question", createdAt: 10, contextProvenance: scoped });
        await origins.record({ guildId, channelId: "channel", messageId: `${guildId}-unrelated`, origin: "chat", sourceMessageId: null, createdAt: 10,
          contextProvenance: { ...scoped, dependencies: scoped.dependencies.map((dependency) => ({ ...dependency, authorId: "carol" })) } });
      }
      await state.commitSuccessfulExchange({ guildId: "guild", userId: "alice", channelId: "channel", userMessage: "legacy", assistantMessage: "legacy answer", actions: [], now: 11 });
      await state.invalidateContextSubject("guild", "bob");
      await origins.invalidateContextSubject("guild", "bob");
      expect((await state.load("guild", "alice", "channel", 12)).exchanges.map((exchange) => exchange.user.content)).toEqual(["legacy"]);
      expect((await state.load("guild", "carol", "channel", 12)).exchanges).toEqual([]);
      expect((await state.load("other-guild", "alice", "channel", 12)).exchanges).toHaveLength(1);
      expect((await origins.find("guild", "channel", "guild-dependent"))?.contextProvenance).toBeNull();
      expect((await origins.find("guild", "channel", "guild-unrelated"))?.contextProvenance).not.toBeNull();
      expect((await origins.find("other-guild", "channel", "other-guild-dependent"))?.contextProvenance).not.toBeNull();
    } finally { connection.close(); }
  });

  it("invalidates reactor-only dependencies and private audience proofs", async () => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "context-actors-")));
    try {
      const origins = new SqliteMessageOriginStore(connection.database); const state = new SqliteChatStateStore(connection.database);
      const fixture = guardedFixture();
      const context = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
      const proof = context.provenance("answer")!;
      for (const kind of ["actor", "audience"] as const) {
        const scoped = kind === "actor" ? { ...proof, actors: [{ userId: "bob", representationHash: proof.outputHash }] }
          : { ...proof, audience: { ...proof.audience, userId: "bob" } };
        await origins.record({ guildId: "guild", channelId: "channel", messageId: kind, origin: "chat", sourceMessageId: null, createdAt: 10, contextProvenance: scoped });
        await state.commitSuccessfulExchange({ guildId: "guild", channelId: "channel", userId: "bob", userMessage: kind,
          assistantMessage: "answer", actions: [], now: 10, contextProvenance: scoped });
      }
      await origins.invalidateContextSubject("guild", "bob"); await state.invalidateContextSubject("guild", "bob");
      expect((await origins.find("guild", "channel", "actor"))?.contextProvenance).toBeNull();
      expect((await origins.find("guild", "channel", "audience"))?.contextProvenance).toBeNull();
      expect((await state.load("guild", "bob", "channel", 11)).exchanges).toEqual([]);
    } finally { connection.close(); }
  });
});
