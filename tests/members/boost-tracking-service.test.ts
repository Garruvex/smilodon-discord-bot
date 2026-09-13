import { describe, expect, it, vi } from "vitest";

import { BoostTrackingService } from "../../src/application/members/boost-tracking-service.js";
import type { BoostHistoryStore } from "../../src/application/members/boost-history-store.js";

function stubStore(): { store: BoostHistoryStore; recordEvent: ReturnType<typeof vi.fn> } {
  const recordEvent = vi.fn().mockResolvedValue(undefined);
  return {
    store: {
      initialize: () => Promise.resolve(),
      recordEvent,
      listEvents: () => Promise.resolve([]),
      removeForUser: () => Promise.resolve(),
    },
    recordEvent,
  };
}

function member(premiumSince: Date | null): { guild: { id: string }; id: string; premiumSince: Date | null } {
  return { guild: { id: "guild" }, id: "user", premiumSince };
}

describe("BoostTrackingService", () => {
  it("records a start event when a member begins boosting", async () => {
    const { store, recordEvent } = stubStore();
    const boostedAt = new Date("2026-01-01T00:00:00Z");

    await new BoostTrackingService(store).handleMemberUpdate(
      member(null) as never,
      member(boostedAt) as never,
    );

    expect(recordEvent).toHaveBeenCalledWith("guild", "user", "started", boostedAt);
  });

  it("records an end event when a member stops boosting", async () => {
    const { store, recordEvent } = stubStore();

    await new BoostTrackingService(store).handleMemberUpdate(
      member(new Date("2026-01-01T00:00:00Z")) as never,
      member(null) as never,
    );

    expect(recordEvent).toHaveBeenCalledWith("guild", "user", "ended", expect.any(Date));
  });

  it("does nothing when boost status is unchanged", async () => {
    const { store, recordEvent } = stubStore();
    const boostedAt = new Date("2026-01-01T00:00:00Z");

    await new BoostTrackingService(store).handleMemberUpdate(
      member(boostedAt) as never,
      member(boostedAt) as never,
    );
    await new BoostTrackingService(store).handleMemberUpdate(
      member(null) as never,
      member(null) as never,
    );

    expect(recordEvent).not.toHaveBeenCalled();
  });
});
