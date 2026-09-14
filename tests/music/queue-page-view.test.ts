import { describe, expect, it } from "vitest";

import { buildQueuePageView, queuePageComponentIdPrefix } from "../../src/infrastructure/discord/music/queue-page-view.js";
import type { MusicTrack } from "../../src/domain/music/music-track.js";

function track(index: number): MusicTrack {
  return {
    identifier: `track-${index}`,
    title: `Track ${index}`,
    author: "Artist",
    uri: `https://example.com/${index}`,
    artworkUrl: null,
    durationMs: 60_000,
    isStream: false,
    requestedByUserId: "111111111111111111",
  };
}

describe("buildQueuePageView", () => {
  it("reports an empty queue with no pagination buttons", () => {
    const view = buildQueuePageView([], 0, "#3B82F6");

    expect(view.embed.toJSON().description).toBe("There are no upcoming tracks.");
    expect(view.components).toHaveLength(0);
  });

  it("shows exactly one page of tracks and disables both buttons when there's only one page", () => {
    const tracks = Array.from({ length: 5 }, (_, i) => track(i));
    const view = buildQueuePageView(tracks, 0, "#3B82F6");

    // A single page still gets no nav row at all — nothing to page to.
    expect(view.components).toHaveLength(0);
  });

  it("clamps an out-of-range page to the last valid page and numbers tracks by absolute position", () => {
    const tracks = Array.from({ length: 25 }, (_, i) => track(i));
    const view = buildQueuePageView(tracks, 99, "#3B82F6");
    const description = view.embed.toJSON().description ?? "";

    // 25 tracks / 10 per page = 3 pages (0, 1, 2) — page 99 clamps to page 2,
    // which holds tracks 21-25.
    expect(description).toContain("21. [Track 20]");
    expect(description).toContain("25. [Track 24]");
    expect(view.embed.toJSON().footer?.text).toContain("Page 3/3");

    const buttons = view.components[0]?.toJSON().components as Array<{ custom_id: string; disabled?: boolean }>;
    expect(buttons.find((b) => b.custom_id === `${queuePageComponentIdPrefix}:1`)?.disabled).toBe(false);
    expect(buttons.find((b) => b.custom_id === `${queuePageComponentIdPrefix}:3`)?.disabled).toBe(true);
  });

  it("disables the Prev button on the first page and enables Next", () => {
    const tracks = Array.from({ length: 25 }, (_, i) => track(i));
    const view = buildQueuePageView(tracks, 0, "#3B82F6");
    const buttons = view.components[0]?.toJSON().components as Array<{ custom_id: string; disabled?: boolean }>;

    expect(buttons.find((b) => b.custom_id === `${queuePageComponentIdPrefix}:-1`)?.disabled).toBe(true);
    expect(buttons.find((b) => b.custom_id === `${queuePageComponentIdPrefix}:1`)?.disabled).toBe(false);
  });
});
