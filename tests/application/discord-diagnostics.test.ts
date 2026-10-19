import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRateLimitDiagnostics, withDiscordCaller } from "../../src/application/diagnostics/discord-diagnostics.js";
import { ChannelEditScheduler } from "../../src/application/concurrency/channel-edit-scheduler.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";
import { withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";

afterEach(() => vi.useRealTimers());
describe("Discord rate-limit diagnostics", () => {
  const path = "/channels/11111111111111111/messages/22222222222222222";
  it("aggregates caller/target counters with bounded cardinality and no URLs or tokens", () => {
    const { logger, records } = captureDiagnosticLogger();
    const diagnostics = new DiscordRateLimitDiagnostics(logger, 2);
    for (let i = 0; i < 100; i++) withDiscordCaller("lyrics_panel", () => diagnostics.observe({ kind: "response_429", method: "PATCH", path: `${path}?token=SECRET`, waitMs: 100 }));
    withDiscordCaller("chat_text", () => diagnostics.observe({ kind: "proactive_wait", method: "POST", path: `https://discord.com/api/v10${path}`, waitMs: 500 }));
    for (let i = 0; i < 100; i++) diagnostics.observe({ kind: "response_429", method: "PATCH", path: `/channels/11111111111111111/messages/${String(33333333333333333n + BigInt(i))}` });
    expect(records).toHaveLength(0);
    withDiagnosticScope({ operation: "chat_turn", guildId: "guild", channelId: "channel", sourceMessageId: "source" }, () => diagnostics.stop());
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.traceId === undefined && record.sourceMessageId === undefined)).toBe(true);
    expect(records[0]).toMatchObject({ caller: "lyrics_panel", count: 100, maxWaitMs: 100, channelId: "11111111111111111", targetMessageId: "22222222222222222" });
    expect(records[1]).toMatchObject({ caller: "chat_text", maxWaitMs: 500, channelId: "11111111111111111" });
    expect(records[2]).toMatchObject({ overflow: true, count: 100, kind: "mixed" });
    expect(JSON.stringify(records)).not.toMatch(/SECRET|https|token/u);
  });
  it("flushes a quiet window once and labels uninstrumented callers unknown", async () => {
    vi.useFakeTimers();
    const { logger, records } = captureDiagnosticLogger();
    const diagnostics = new DiscordRateLimitDiagnostics(logger);
    diagnostics.observe({ kind: "response_429", method: "PATCH", path });
    await vi.advanceTimersByTimeAsync(120_000); diagnostics.stop();
    diagnostics.observe({ kind: "response_429", method: "PATCH", path });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ caller: "unknown", count: 1 });
  });
  it("attributes scheduled edits to their registered caller", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const diagnostics = new DiscordRateLimitDiagnostics(logger);
    const scheduler = new ChannelEditScheduler();
    const slot = scheduler.register({ channelId: "channel", key: "lyrics", priority: 1, caller: "lyrics_panel" });
    await slot.schedule(() => {
      diagnostics.observe({ kind: "response_429", method: "PATCH", path });
      return Promise.resolve(true);
    });
    scheduler.stop(); diagnostics.stop();
    expect(records[0]).toMatchObject({ caller: "lyrics_panel" });
  });
});
