import { describe, expect, it } from "vitest";

import { EmbeddingGuildMemorySelector } from "../../src/application/chat/guild-memory-selector.js";
import type { GuildKnowledgeRecord } from "../../src/application/chat/chat-provider.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

function record(overrides: Partial<GuildKnowledgeRecord>): GuildKnowledgeRecord {
  return {
    id: "id", subjectType: "guild", subjectId: "guild", topic: "community", slot: "activity",
    statement: "placeholder", source: "administrator", updatedAt: 0, embedding: null,
    ...overrides,
  };
}

describe("EmbeddingGuildMemorySelector", () => {
  it("ranks a semantically similar record above a lexically-matching but less similar one", async () => {
    const raidRecord = record({ id: "raid", statement: "organizes the weekend raid", embedding: [1, 0] });
    const unrelatedRecord = record({ id: "unrelated", statement: "collects vintage stamps", embedding: [0, 1] });
    const embeddingsClient: EmbeddingsClient = { embed: () => Promise.resolve([1, 0]) };
    const selector = new EmbeddingGuildMemorySelector(embeddingsClient);

    const selected = await selector.select({
      records: [unrelatedRecord, raidRecord],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "who's running the dungeon this weekend",
      now: 1_000,
    });

    expect(selected[0]!.id).toBe("raid");
  });

  it("treats a record with no stored embedding as 0 similarity instead of erroring", async () => {
    const legacyRecord = record({ id: "legacy", statement: "some old fact", embedding: null });
    const embeddingsClient: EmbeddingsClient = { embed: () => Promise.resolve([1, 0]) };
    const selector = new EmbeddingGuildMemorySelector(embeddingsClient);

    const selected = await selector.select({
      records: [legacyRecord],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "anything",
      now: 1_000,
    });

    expect(selected).toHaveLength(1);
  });

  it("degrades to lexical-only scoring when the query embed call fails", async () => {
    const knownRecord = record({ id: "known", statement: "organizes Friday raids", embedding: [1, 0] });
    const embeddingsClient: EmbeddingsClient = { embed: () => Promise.reject(new Error("network error")) };
    const selector = new EmbeddingGuildMemorySelector(embeddingsClient);

    await expect(selector.select({
      records: [knownRecord],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "who organizes Friday raids",
      now: 1_000,
    })).resolves.toHaveLength(1);
  });
});
