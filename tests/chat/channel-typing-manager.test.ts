import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelTypingManager } from "../../src/application/chat/channel-typing-manager.js";

describe("ChannelTypingManager", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes typing until the active request finishes", async () => {
    vi.useFakeTimers();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const manager = new ChannelTypingManager();

    const stop = manager.start("channel", sendTyping);
    expect(sendTyping).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(16_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
  });

  it("keeps typing while another request in the same channel is active", async () => {
    vi.useFakeTimers();
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const manager = new ChannelTypingManager();

    const stopFirst = manager.start("channel", sendTyping);
    const stopSecond = manager.start("channel", sendTyping);
    expect(sendTyping).toHaveBeenCalledOnce();

    stopFirst();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    stopSecond();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("tracks different channels independently", () => {
    vi.useFakeTimers();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const manager = new ChannelTypingManager();

    const stopFirst = manager.start("first", first);
    const stopSecond = manager.start("second", second);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    stopFirst();
    stopSecond();
  });
});
