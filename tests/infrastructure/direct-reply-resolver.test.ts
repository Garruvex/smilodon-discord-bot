import type { Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvesReplyToBot } from "../../src/infrastructure/discord/behaviors/direct-reply-resolver.js";
afterEach(() => vi.useRealTimers());
function source(fetch: ReturnType<typeof vi.fn>): Message {
  return { guildId: "guild", channelId: "channel", reference: { messageId: "target", channelId: "channel" }, mentions: {}, channel: { messages: { cache: new Map(), fetch } } } as unknown as Message;
}
describe("bounded direct reply resolution", () => {
  it("does not start a target fetch when lazy authorization completes after the routing deadline", async () => {
    vi.useFakeTimers(); let release!: (allowed: boolean) => void;
    const fetch = vi.fn();
    const result = resolvesReplyToBot(source(fetch), "bot", null, 50, () => new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(50); expect(await result).toBe(false);
    release(true); await Promise.resolve(); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
  });
  it("resolves exactly one same-channel target without forwarding its content", async () => {
    const fetch = vi.fn().mockResolvedValue({ guildId: "guild", channelId: "channel", author: { id: "bot" }, content: "PRIVATE", reference: { messageId: "ancestor" } });
    expect(await resolvesReplyToBot(source(fetch), "bot", null)).toBe(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("target");
  });
  it("fails closed on disabled fetch, cross-channel envelopes and fetch failure", async () => {
    const fetch = vi.fn().mockResolvedValue({ guildId: "guild", channelId: "other", author: { id: "bot" } });
    expect(await resolvesReplyToBot(source(fetch), "bot", null, 1500, false)).toBe(false); expect(fetch).not.toHaveBeenCalled();
    expect(await resolvesReplyToBot(source(fetch), "bot", null)).toBe(false);
    fetch.mockRejectedValue(new Error("unavailable")); expect(await resolvesReplyToBot(source(fetch), "bot", null)).toBe(false);
  });
  it("bounds a stalled target request and ignores its eventual result", async () => {
    vi.useFakeTimers(); let release!: (value: unknown) => void;
    const result = resolvesReplyToBot(source(vi.fn(() => new Promise((resolve) => { release = resolve; }))), "bot", null, 50);
    await vi.advanceTimersByTimeAsync(50); expect(await result).toBe(false);
    release({ guildId: "guild", channelId: "channel", author: { id: "bot" } }); await Promise.resolve();
  });
});
