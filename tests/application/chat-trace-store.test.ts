import { describe, expect, it } from "vitest";
import { BoundedChatTraceBuffer } from "../../src/application/diagnostics/chat-trace-store.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";

const query = { guildId: "guild", channelId: "channel", sourceMessageId: "source" };
const base = diagnosticRecord();

describe("bounded content-free trace buffer", () => {
  it("validates records, strips unexpected content, and isolates guild/channel/source groups", () => {
    const buffer = new BoundedChatTraceBuffer({}, () => 1000);
    buffer.record({ ...base, secret: "SECRET_ROOT", data: { ...base.data, prompt: "SECRET_PROMPT" } });
    buffer.record(diagnosticRecord({ scope: { ...base.scope, channelId: "other", sourceMessageId: "other" } }));
    buffer.record(diagnosticRecord({ scope: { ...base.scope, guildId: "other-guild" } }));
    expect(buffer.lookup(query)[0]?.records).toHaveLength(1);
    expect(buffer.lookup({ ...query, channelId: "other" })).toEqual([]);
    expect(JSON.stringify(buffer.snapshot())).not.toContain("SECRET");
    expect(buffer.record({ ...base, data: { event: "unknown", secret: "SECRET" } })).toBe(false);
    expect(buffer.status().invalidRecords).toBe(1);
  });

  it("cannot be mutated through its lookup or snapshot results", () => {
    const buffer = new BoundedChatTraceBuffer({}, () => 1000);
    buffer.record(base);
    buffer.lookup(query)[0]!.records[0]!.scope.sourceMessageId = "changed";
    buffer.snapshot()[0]!.records[0]!.scope.channelId = "changed";
    expect(buffer.lookup(query)[0]?.records[0]?.scope).toMatchObject(query);
  });

  it("caps records per source group and reports truncation", () => {
    const buffer = new BoundedChatTraceBuffer({ maxEventsPerTrace: 2 }, () => 1000);
    for (let eventSequence = 1; eventSequence <= 3; eventSequence++) buffer.record(diagnosticRecord({ eventSequence }));
    expect(buffer.lookup(query)[0]).toMatchObject({ truncated: true });
    expect(buffer.lookup(query)[0]?.records.map((record) => record.eventSequence)).toEqual([2, 3]);
    expect(buffer.status()).toMatchObject({ traces: 1, events: 2, droppedEvents: 1 });
  });

  it("bounds global events/bytes and per-guild trace counts", () => {
    const size = Buffer.byteLength(JSON.stringify(base), "utf8");
    for (const limits of [{ maxEvents: 1 }, { maxBytes: size + 1 }, { maxTracesPerGuild: 1 }, { maxTraces: 1 }]) {
      const buffer = new BoundedChatTraceBuffer(limits, () => 1000);
      buffer.record(base);
      buffer.record(diagnosticRecord({ scope: { ...base.scope, traceId: "newer" } }));
      expect(buffer.status()).toMatchObject({ traces: 1, events: 1, droppedTraces: 1 });
      expect(buffer.status().bytes).toBeLessThanOrEqual(limits.maxBytes ?? 4 * 1024 * 1024);
    }
    const tooSmall = new BoundedChatTraceBuffer({ maxBytes: 1 }, () => 1000);
    expect(tooSmall.record(base)).toBe(false);
    expect(tooSmall.status()).toMatchObject({ traces: 0, events: 0, droppedEvents: 1 });
  });

  it("expires every old record even if events arrived out of timestamp order", () => {
    let now = 1000;
    const buffer = new BoundedChatTraceBuffer({ retentionMs: 1000 }, () => now);
    buffer.record(base);
    buffer.record(diagnosticRecord({ timestampMs: 900, eventSequence: 2 }));
    now = 1100;
    buffer.record(diagnosticRecord({ timestampMs: 1100, eventSequence: 3 }));
    now = 2000;
    expect(buffer.lookup(query)[0]?.records.map((record) => record.eventSequence)).toEqual([3]);
    now = 2100;
    expect(buffer.lookup(query)).toEqual([]);
    expect(buffer.status()).toMatchObject({ traces: 0, bytes: 0, events: 0, expiredTraces: 1 });
  });

  it("forgets guild records and rejects late events while allowing newly started traces", () => {
    const buffer = new BoundedChatTraceBuffer({}, () => 1000);
    buffer.record(base);
    buffer.record(diagnosticRecord({ scope: { ...base.scope, guildId: "other" } }));
    buffer.forgetGuild("guild", 1);
    expect(buffer.record(base)).toBe(false);
    expect(buffer.lookup(query)).toEqual([]);
    expect(buffer.lookup({ ...query, guildId: "other" })).toHaveLength(1);
    expect(buffer.record(diagnosticRecord({ scope: { ...base.scope, traceSequence: 2 } }))).toBe(true);
  });

  it("excludes traces referencing a removed source and prevents resurrection by later events", () => {
    const buffer = new BoundedChatTraceBuffer({}, () => 1000);
    buffer.record(diagnosticRecord({ data: { event: "context.eligibility.denied", sourceMessageId: "removed", purpose: "observation", reason: "access_denied" } }));
    buffer.excludeSource({ ...query, sourceMessageId: "removed" }, 1);
    expect(buffer.lookup(query)).toEqual([]);
    expect(buffer.record(base)).toBe(false);
  });

  it("keeps unrelated in-flight traces after a source edit and resolves delivered-message IDs", () => {
    const buffer = new BoundedChatTraceBuffer({}, () => 1000);
    buffer.record(base);
    const other = diagnosticRecord({ scope: { ...base.scope, traceId: "other", sourceMessageId: "other", traceSequence: 2 } });
    buffer.record(other);
    buffer.excludeSource(query, 2);
    expect(buffer.record(other)).toBe(true);
    buffer.record({ ...other, data: { event: "chat.delivery.part", deliveredMessageId: "reply", part: 1 } });
    expect(buffer.lookup({ ...query, sourceMessageId: "reply" })[0]?.records).toHaveLength(3);
    buffer.excludeSource({ ...query, sourceMessageId: "reply" }, 2);
    expect(buffer.record(other)).toBe(false);
    expect(buffer.lookup({ ...query, sourceMessageId: "other" })).toEqual([]);
  });
});
