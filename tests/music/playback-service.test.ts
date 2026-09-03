import { describe, expect, it, vi } from "vitest";

import {
  MusicPlayerNotFoundError,
  MusicRateLimitError,
  MusicVoiceChannelMismatchError,
  MusicVoiceChannelRequiredError,
} from "../../src/application/music/music-errors.js";
import type { MusicPlayerGateway } from "../../src/application/music/music-player-gateway.js";
import {
  PlaybackService,
  type PlaybackActor,
} from "../../src/application/music/playback-service.js";

function createGateway(): MusicPlayerGateway {
  return {
    initialize: vi.fn(() => Promise.resolve()),
    acceptDiscordGatewayPayload: vi.fn(),
    enqueue: vi.fn(() =>
      Promise.resolve({
        firstTrack: {
          identifier: "track-id",
          title: "Track",
          author: "Artist",
          uri: "https://example.com/track",
          artworkUrl: null,
          durationMs: 60_000,
          isStream: false,
          requestedByUserId: "user-id",
        },
        addedTrackCount: 1,
        startedPlayback: true,
        queuePosition: null,
      }),
    ),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    skip: vi.fn(() => Promise.resolve()),
    skipTo: vi.fn(() =>
      Promise.resolve({
        identifier: "track-id",
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        isStream: false,
        requestedByUserId: "user-id",
      }),
    ),
    previous: vi.fn(() => Promise.resolve()),
    changeVolume: vi.fn(() => Promise.resolve()),
    setVolume: vi.fn(() => Promise.resolve()),
    shuffle: vi.fn(() => Promise.resolve()),
    getQueue: vi.fn(() => []),
    getPlayHistory: vi.fn(() => []),
    removeQueueTrack: vi.fn(() => Promise.reject(new Error("not implemented"))),
    moveQueueTrack: vi.fn(() =>
      Promise.resolve({
        identifier: "track-id",
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        isStream: false,
        requestedByUserId: "user-id",
      }),
    ),
    clearQueue: vi.fn(() => Promise.resolve(0)),
    seek: vi.fn(() =>
      Promise.resolve({
        identifier: "track-id",
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        isStream: false,
        requestedByUserId: "user-id",
      }),
    ),
    replay: vi.fn(() =>
      Promise.resolve({
        identifier: "track-id",
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        isStream: false,
        requestedByUserId: "user-id",
      }),
    ),
    setRepeatMode: vi.fn(() => Promise.resolve()),
    setFilterPreset: vi.fn(() => Promise.resolve()),
    toggleAutoQueue: vi.fn(() => Promise.resolve(true)),
    toggleTwentyFourSeven: vi.fn(() => Promise.resolve(true)),
    handleBotVoiceDisconnect: vi.fn(() => Promise.resolve()),
    reconcileVoiceState: vi.fn(() => Promise.resolve(false)),
    handleVoiceChannelOccupancy: vi.fn(),
    handleGuildRemoved: vi.fn(() => Promise.resolve()),
    hasPlayer: vi.fn(() => true),
    isPaused: vi.fn(() => false),
    getVoiceChannelId: vi.fn(() => "voice-id"),
    getSnapshot: vi.fn(() => null),
  };
}

function createActor(voiceChannelId: string | null = "voice-id"): PlaybackActor {
  return {
    guildId: "guild-id",
    textChannelId: "text-id",
    userId: "user-id",
    voiceChannelId,
  };
}

describe("PlaybackService", () => {
  it("enqueues through the gateway after voice validation", async () => {
    const gateway = createGateway();
    const service = new PlaybackService(gateway);

    await service.enqueue(createActor(), "song name");

    // The gateway is a test double; the method is never detached or invoked here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.enqueue).toHaveBeenCalledWith({
      guildId: "guild-id",
      voiceChannelId: "voice-id",
      textChannelId: "text-id",
      query: "song name",
      requestedByUserId: "user-id",
    });
  });

  it("rejects an actor who is not in voice", async () => {
    const service = new PlaybackService(createGateway());

    await expect(service.enqueue(createActor(null), "song")).rejects.toBeInstanceOf(
      MusicVoiceChannelRequiredError,
    );
  });

  it("rejects control from another voice channel", async () => {
    const gateway = createGateway();
    gateway.getVoiceChannelId = vi.fn(() => "different-voice-id");
    const service = new PlaybackService(gateway);

    await expect(service.pause(createActor())).rejects.toBeInstanceOf(
      MusicVoiceChannelMismatchError,
    );
  });

  it("rejects control when no player exists", async () => {
    const gateway = createGateway();
    gateway.hasPlayer = vi.fn(() => false);
    const service = new PlaybackService(gateway);

    await expect(service.stop(createActor())).rejects.toBeInstanceOf(
      MusicPlayerNotFoundError,
    );
  });

  it("rejects enqueue requests that arrive too quickly", async () => {
    const gateway = createGateway();
    const service = new PlaybackService(gateway);
    const actor = createActor();

    await service.enqueue(actor, "first song");
    await expect(service.enqueue(actor, "second song")).rejects.toBeInstanceOf(MusicRateLimitError);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.enqueue).toHaveBeenCalledTimes(1);
  });

  it("rate limits a request whose search failed", async () => {
    const gateway = createGateway();
    gateway.enqueue = vi.fn(() => Promise.reject(new Error("no playable tracks")));
    const service = new PlaybackService(gateway);
    const actor = createActor();

    await expect(service.enqueue(actor, "bogus query")).rejects.toThrow("no playable tracks");
    await expect(service.enqueue(actor, "bogus query")).rejects.toBeInstanceOf(MusicRateLimitError);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not rate limit a request rejected before the search", async () => {
    const gateway = createGateway();
    const service = new PlaybackService(gateway);

    await expect(service.enqueue(createActor(null), "song")).rejects.toBeInstanceOf(
      MusicVoiceChannelRequiredError,
    );
    await expect(service.enqueue(createActor(), "song")).resolves.toBeDefined();
  });

  it("routes skip through the gateway after control validation", async () => {
    const gateway = createGateway();
    const service = new PlaybackService(gateway);

    await service.skip(createActor());

    // The gateway is a test double; the method is never detached or invoked here.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.skip).toHaveBeenCalledWith("guild-id");
  });

  it("routes core queue and mode controls through the gateway", async () => {
    const gateway = createGateway();
    const service = new PlaybackService(gateway);
    const actor = createActor();

    await service.setVolume(actor, 90, 150);
    await service.setRepeatMode(actor, "queue");
    await service.toggleAutoQueue(actor);
    await service.toggleTwentyFourSeven(actor);
    await service.clearQueue(actor);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.setVolume).toHaveBeenCalledWith("guild-id", 90, 150);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.setRepeatMode).toHaveBeenCalledWith("guild-id", "queue");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.toggleAutoQueue).toHaveBeenCalledWith("guild-id");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.toggleTwentyFourSeven).toHaveBeenCalledWith("guild-id");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.clearQueue).toHaveBeenCalledWith("guild-id");
  });

  it("reads play history straight from the gateway, no voice validation required", () => {
    const gateway = createGateway();
    (gateway.getPlayHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { identifier: "a", title: "Track A", author: "Artist A", uri: "https://example.com/a", artworkUrl: null, durationMs: 1000, isStream: false, requestedByUserId: "user-id", playedAt: 100 },
    ]);
    const service = new PlaybackService(gateway);

    const history = service.getPlayHistory("guild-id");

    expect(history).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(gateway.getPlayHistory).toHaveBeenCalledWith("guild-id");
  });
});
