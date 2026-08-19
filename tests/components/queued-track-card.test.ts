import { describe, expect, it } from "vitest";

import { createQueuedTrackCard } from "../../src/infrastructure/discord/music/queued-track-card.js";
import type { EnqueueResult } from "../../src/domain/music/music-track.js";

function result(overrides: Partial<EnqueueResult> = {}): EnqueueResult {
  return {
    firstTrack: {
      identifier: "track-id",
      title: "Rice Field",
      author: "Jay Chou",
      uri: "https://example.com/rice-field",
      artworkUrl: "https://example.com/artwork.jpg",
      durationMs: 224_000,
      isStream: false,
      requestedByUserId: "123456789012345678",
    },
    addedTrackCount: 1,
    startedPlayback: false,
    queuePosition: 3,
    ...overrides,
  };
}

describe("createQueuedTrackCard", () => {
  it("presents resolved track metadata and queue position", () => {
    const card = createQueuedTrackCard(result(), "#3B82F6").toJSON();

    expect(card.title).toBe("Added to queue");
    expect(card.description).toContain("Rice Field");
    expect(card.thumbnail?.url).toBe("https://example.com/artwork.jpg");
    expect(card.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Artist", value: "Jay Chou" }),
      expect.objectContaining({ name: "Duration", value: "`3:44`" }),
      expect.objectContaining({ name: "Position in queue", value: "3" }),
    ]));
  });

  it("summarizes playlists without hiding the first resolved track", () => {
    const card = createQueuedTrackCard(result({ addedTrackCount: 12 })).toJSON();

    expect(card.title).toBe("Playlist added");
    expect(card.description).toContain("Rice Field");
    expect(card.fields).toContainEqual(expect.objectContaining({
      name: "Tracks added",
      value: "12",
    }));
  });

  it("labels streams instead of showing a zero duration", () => {
    const base = result();
    const card = createQueuedTrackCard({
      ...base,
      firstTrack: { ...base.firstTrack, isStream: true, durationMs: 0 },
    }).toJSON();

    expect(card.fields).toContainEqual(expect.objectContaining({
      name: "Duration",
      value: "`LIVE 🔴`",
    }));
  });
});
