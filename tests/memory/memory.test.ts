import { describe, expect, it } from "vitest";

import { canRecall, type Memory } from "../../src/application/memory/memory.js";

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: "m1", guildId: "guild", kind: "fact", audience: "guild",
    ownerUserId: null, channelId: null, isolationChannelId: null,
    subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
    statement: "likes apples", structuredValue: null, status: "active", supersededById: null,
    source: "live", confidence: 1, importance: 1, embedding: null, embeddingModel: null,
    createdAt: 0, updatedAt: 0, expiresAt: null, validFrom: 0, validUntil: null,
    ...overrides,
  };
}

const now = 1_000;

describe("canRecall", () => {
  it("guild-audience, no isolation: available everywhere in the guild", () => {
    const record = memory({ audience: "guild" });
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "bob" }, now)).toBe(true);
    expect(canRecall(record, { guildId: "guild", channelId: "dnd", userId: "bob" }, now)).toBe(true);
  });

  it("channel-audience isolated to #dnd: only available in #dnd", () => {
    const record = memory({ audience: "channel", channelId: "dnd", isolationChannelId: "dnd" });
    expect(canRecall(record, { guildId: "guild", channelId: "dnd", userId: "bob" }, now)).toBe(true);
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "bob" }, now)).toBe(false);
  });

  it("private, no isolation: available to the owner in any channel", () => {
    const record = memory({ audience: "private", ownerUserId: "alice" });
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "alice" }, now)).toBe(true);
    expect(canRecall(record, { guildId: "guild", channelId: "dnd", userId: "alice" }, now)).toBe(true);
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "bob" }, now)).toBe(false);
  });

  it("private, isolated to #dnd: only the owner, only in #dnd", () => {
    const record = memory({ audience: "private", ownerUserId: "alice", isolationChannelId: "dnd" });
    expect(canRecall(record, { guildId: "guild", channelId: "dnd", userId: "alice" }, now)).toBe(true);
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "alice" }, now)).toBe(false);
    expect(canRecall(record, { guildId: "guild", channelId: "dnd", userId: "bob" }, now)).toBe(false);
  });

  it("rejects a different guild regardless of audience", () => {
    const record = memory({ audience: "guild" });
    expect(canRecall(record, { guildId: "other-guild", channelId: "general", userId: "bob" }, now)).toBe(false);
  });

  it("rejects a non-active memory", () => {
    const record = memory({ audience: "guild", status: "candidate" });
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "bob" }, now)).toBe(false);
  });

  it("rejects an expired memory", () => {
    const record = memory({ audience: "guild", expiresAt: now - 1 });
    expect(canRecall(record, { guildId: "guild", channelId: "general", userId: "bob" }, now)).toBe(false);
  });
});
