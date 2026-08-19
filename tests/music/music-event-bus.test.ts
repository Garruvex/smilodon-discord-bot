import { describe, expect, it, vi } from "vitest";

import { MusicEventBus } from "../../src/application/music/music-event-bus.js";

describe("MusicEventBus", () => {
  it("publishes state changes to every listener", async () => {
    const eventBus = new MusicEventBus();
    const firstListener = vi.fn(() => Promise.resolve());
    const secondListener = vi.fn(() => Promise.resolve());
    eventBus.subscribe(firstListener);
    eventBus.subscribe(secondListener);

    const event = { guildId: "guild-id", reason: "paused" as const };
    await eventBus.publish(event);

    expect(firstListener).toHaveBeenCalledWith(event);
    expect(secondListener).toHaveBeenCalledWith(event);
  });

  it("supports unsubscribing a listener", async () => {
    const eventBus = new MusicEventBus();
    const listener = vi.fn(() => Promise.resolve());
    const unsubscribe = eventBus.subscribe(listener);
    unsubscribe();

    await eventBus.publish({ guildId: "guild-id", reason: "stopped" });

    expect(listener).not.toHaveBeenCalled();
  });
});

