import { ChannelType, PermissionsBitField, type Client, type Guild } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LavalinkPlayerGateway } from "../../src/infrastructure/lavalink/lavalink-player-gateway.js";
import { MusicChannelAccessError } from "../../src/application/music/music-errors.js";
import type { MusicEventBus } from "../../src/application/music/music-event-bus.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { LyricsCacheStore } from "../../src/application/lyrics/lyrics-cache-store.js";

const lookupSyncedLyricsMock = vi.fn();
vi.mock("../../src/infrastructure/lyrics/synced-lyrics-client.js", () => ({
  lookupSyncedLyrics: (...args: unknown[]): unknown => lookupSyncedLyricsMock(...args),
  // Identity passthrough — none of these fixtures need real suffix-stripping,
  // and the cache-key tests below rely on the raw title/artist round-tripping
  // unchanged.
  lyricsCacheIdentity: (title: string, artist: string): unknown => ({ title, artist }),
}));

interface TestLyricLine { timestampMs: number; line: string }

function found(lines: TestLyricLine[]): unknown {
  return { result: { status: "found", lines, source: "lrclib" }, attempts: [] };
}

function notFound(): unknown {
  return { result: { status: "not_found" }, attempts: [] };
}

function unavailable(retryable = true): unknown {
  return {
    result: { status: "unavailable", source: "lrclib", errorCode: "timeout", retryable },
    attempts: [{ source: "lrclib", outcome: "failed", durationMs: 5_000, errorCode: "timeout" }],
  };
}

const guildId = "123456789012345678";

interface FakePlayer {
  guildId: string;
  voiceChannelId: string | null;
  destroy: ReturnType<typeof vi.fn>;
}

function createFakePlayer(voiceChannelId: string | null): FakePlayer {
  return { guildId, voiceChannelId, destroy: vi.fn().mockResolvedValue(undefined) };
}

const uncachedGuild = Symbol("uncached-guild");

function createGateway(botVoiceChannelId: string | null | typeof uncachedGuild): {
  gateway: LavalinkPlayerGateway;
  stubPlayer: (player: FakePlayer | null) => void;
} {
  const isUncached = botVoiceChannelId === uncachedGuild;
  const guild = {
    id: guildId,
    members: { me: { voice: { channelId: isUncached ? null : botVoiceChannelId } } },
    shard: { send: vi.fn() },
  } as unknown as Guild;
  const client = {
    guilds: {
      cache: isUncached
        ? new Map<string, Guild>()
        : new Map<string, Guild>([[guildId, guild]]),
    },
  } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
  const guildConfigurationProvider = {
    find: vi.fn(() => undefined),
  } as unknown as GuildConfigurationProvider;

  const gateway = new LavalinkPlayerGateway(
    client,
    { host: "localhost", port: 2333, password: "pw", secure: false },
    logger as never,
    eventBus,
    guildConfigurationProvider,
  );

  const manager = (
    gateway as unknown as { manager: { getPlayer: (id: string) => FakePlayer | undefined } }
  ).manager;

  return {
    gateway,
    stubPlayer: (player: FakePlayer | null): void => {
      manager.getPlayer = vi.fn(() => player ?? undefined);
    },
  };
}

describe("LavalinkPlayerGateway.reconcileVoiceState", () => {
  it("does nothing when there is no player", async () => {
    const { gateway, stubPlayer } = createGateway(null);
    stubPlayer(null);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(false);
  });

  it("leaves a healthy player alone when the bot's channel matches the player's channel", async () => {
    const { gateway, stubPlayer } = createGateway("111111111111111111");
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(false);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("destroys a stale player after a full voice disconnect", async () => {
    const { gateway, stubPlayer } = createGateway(null);
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(true);
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a stale player when its channel was deleted out from under it", async () => {
    // A deleted channel surfaces the same way as a disconnect: the bot's
    // real voice state reports no channel, while the Lavalink player still
    // remembers the (now-gone) channel id.
    const { gateway, stubPlayer } = createGateway(null);
    const player = createFakePlayer("deleted-channel-id");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(true);
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a stale player when the bot ends up in a different channel than the player recorded", async () => {
    const { gateway, stubPlayer } = createGateway("222222222222222222");
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(true);
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("treats an uncached guild as unverifiable and does not destroy the player", async () => {
    const { gateway, stubPlayer } = createGateway(uncachedGuild);
    const player = createFakePlayer("111111111111111111");
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).resolves.toBe(false);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("propagates a failed destroy instead of silently reporting recovery", async () => {
    const { gateway, stubPlayer } = createGateway(null);
    const player = createFakePlayer("111111111111111111");
    player.destroy.mockRejectedValue(new Error("Lavalink node unreachable"));
    stubPlayer(player);

    await expect(gateway.reconcileVoiceState(guildId)).rejects.toThrow("Lavalink node unreachable");
  });
});

const targetVoiceChannelId = "999999999999999999";

function createGatewayForEnqueue(channelPermissionBits: bigint | null): {
  gateway: LavalinkPlayerGateway;
  createPlayerSpy: ReturnType<typeof vi.fn>;
} {
  const channel = channelPermissionBits === null ? undefined : {
    isVoiceBased: (): boolean => true,
    type: ChannelType.GuildVoice,
    permissionsFor: (): PermissionsBitField => new PermissionsBitField(channelPermissionBits),
  };
  const guild = {
    id: guildId,
    members: { me: { id: "bot-id" } },
    channels: { cache: new Map(channel ? [[targetVoiceChannelId, channel]] : []) },
  } as unknown as Guild;
  const client = {
    guilds: { cache: new Map([[guildId, guild]]) },
  } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
  const guildConfigurationProvider = {
    find: vi.fn(() => undefined),
  } as unknown as GuildConfigurationProvider;

  const gateway = new LavalinkPlayerGateway(
    client,
    { host: "localhost", port: 2333, password: "pw", secure: false },
    logger as never,
    eventBus,
    guildConfigurationProvider,
  );

  const manager = (
    gateway as unknown as {
      manager: { getPlayer: () => undefined; createPlayer: ReturnType<typeof vi.fn> };
    }
  ).manager;
  manager.getPlayer = vi.fn(() => undefined);
  const createPlayerSpy = vi.fn(() => {
    throw new Error("reached createPlayer");
  });
  manager.createPlayer = createPlayerSpy;

  return { gateway, createPlayerSpy };
}

describe("LavalinkPlayerGateway.enqueue voice-channel access gate", () => {
  // A fresh join (no existing player) is the only case that needs this —
  // assertSameVoiceChannel (PlaybackService) already guarantees the bot is
  // in an existing player's channel, so a repeat enqueue never hits it.
  it("rejects a fresh join when the bot lacks Connect in the target channel", async () => {
    const { gateway, createPlayerSpy } = createGatewayForEnqueue(
      new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]).bitfield,
    );

    await expect(
      gateway.enqueue({
        guildId, voiceChannelId: targetVoiceChannelId, textChannelId: "text-id",
        query: "song", requestedByUserId: "user-id",
      }),
    ).rejects.toBeInstanceOf(MusicChannelAccessError);
    expect(createPlayerSpy).not.toHaveBeenCalled();
  });

  it("rejects a fresh join into a channel the bot can't even see (e.g. deleted or uncached)", async () => {
    const { gateway, createPlayerSpy } = createGatewayForEnqueue(null);

    await expect(
      gateway.enqueue({
        guildId, voiceChannelId: targetVoiceChannelId, textChannelId: "text-id",
        query: "song", requestedByUserId: "user-id",
      }),
    ).rejects.toBeInstanceOf(MusicChannelAccessError);
    expect(createPlayerSpy).not.toHaveBeenCalled();
  });

  it("lets a fresh join through to the player once the bot has full channel access", async () => {
    const { gateway, createPlayerSpy } = createGatewayForEnqueue(
      new PermissionsBitField([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
      ]).bitfield,
    );

    await expect(
      gateway.enqueue({
        guildId, voiceChannelId: targetVoiceChannelId, textChannelId: "text-id",
        query: "song", requestedByUserId: "user-id",
      }),
    ).rejects.toThrow("reached createPlayer");
    expect(createPlayerSpy).toHaveBeenCalledOnce();
  });
});

describe("LavalinkPlayerGateway.getQueue", () => {
  it("returns an empty array instead of throwing when there is no player", () => {
    const { gateway, stubPlayer } = createGateway(null);
    stubPlayer(null);

    expect(gateway.getQueue(guildId)).toEqual([]);
  });
});

describe("LavalinkPlayerGateway.resolveSyncedLyrics", () => {
  interface CacheTestGateway {
    resolveSyncedLyrics: (trackName: string, artistName: string) => Promise<unknown>;
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  }

  function createGatewayWithCache(cacheStore: LyricsCacheStore | null): CacheTestGateway {
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;

    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
      cacheStore,
    );

    const internals = gateway as unknown as {
      resolveSyncedLyrics: (track: { title: string; author: string }, context: unknown) => Promise<unknown>;
    };
    return {
      resolveSyncedLyrics: (trackName, artistName) => internals.resolveSyncedLyrics(
        { title: trackName, author: artistName },
        { requestId: "req-1", purpose: "playback", guildId },
      ),
      logger,
    };
  }

  beforeEach(() => {
    lookupSyncedLyricsMock.mockReset();
  });

  it("returns a cached hit without calling LRCLIB", async () => {
    const cachedLines = [{ timestampMs: 0, line: "Cached line" }];
    const cache = {
      get: vi.fn().mockResolvedValue(cachedLines),
      set: vi.fn(),
    } as unknown as LyricsCacheStore;
    const gateway = createGatewayWithCache(cache);

    const result = await gateway.resolveSyncedLyrics("Track", "Artist");

    expect(result).toEqual({ status: "found", lines: cachedLines });
    expect(lookupSyncedLyricsMock).not.toHaveBeenCalled();
  });

  it("treats a cached null as a confirmed not-found, without calling LRCLIB", async () => {
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
    } as unknown as LyricsCacheStore;
    const gateway = createGatewayWithCache(cache);

    const result = await gateway.resolveSyncedLyrics("Track", "Artist");

    expect(result).toEqual({ status: "not_found" });
    expect(lookupSyncedLyricsMock).not.toHaveBeenCalled();
  });

  it("fetches from LRCLIB and writes the result back to the cache on a miss", async () => {
    const freshLines = [{ timestampMs: 1000, line: "Fresh line" }];
    lookupSyncedLyricsMock.mockResolvedValue(found(freshLines));
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: setSpy } as unknown as LyricsCacheStore;
    const gateway = createGatewayWithCache(cache);

    const result = await gateway.resolveSyncedLyrics("Track", "Artist");

    expect(result).toEqual({ status: "found", lines: freshLines });
    expect(lookupSyncedLyricsMock).toHaveBeenCalledWith("Track", "Artist", undefined, expect.anything());
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledWith("v3|track|artist|", freshLines));
  });

  it("writes one lookup report with every source's outcome and the request ID", async () => {
    lookupSyncedLyricsMock.mockImplementation((_title: string, _artist: string, _duration: unknown, options: {
      onCandidate: (decision: unknown) => void;
    }) => {
      options.onCandidate({ source: "lrclib", trackName: "Track", artistNames: ["Artist"], score: 97, verdict: "eligible" });
      return Promise.resolve({
        result: { status: "found", lines: [{ timestampMs: 0, line: "secret lyric" }], source: "netease" },
        attempts: [
          { source: "lrclib", outcome: "failed", durationMs: 5_000, errorCode: "timeout" },
          { source: "netease", outcome: "found", durationMs: 300 },
        ],
      });
    });
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) };
    const gateway = createGatewayWithCache(cache);

    await gateway.resolveSyncedLyrics("Track", "Artist");

    expect(gateway.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req-1",
      purpose: "playback",
      cache: "miss",
      status: "found",
      source: "netease",
      lineCount: 1,
      attempts: [
        expect.objectContaining({ source: "lrclib", outcome: "failed", errorCode: "timeout" }),
        expect.objectContaining({ source: "netease", outcome: "found" }),
      ],
    }), "Lyrics lookup finished");
    expect(gateway.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", verdict: "eligible", score: 97 }),
      "Lyrics candidate scored",
    );
    // Lyric text never reaches the logs.
    expect(JSON.stringify([gateway.logger.info.mock.calls, gateway.logger.debug.mock.calls])).not.toContain("secret lyric");
  });

  it("reports an outage at warn level with its error code", async () => {
    lookupSyncedLyricsMock.mockResolvedValue(unavailable());
    const gateway = createGatewayWithCache(null);

    await gateway.resolveSyncedLyrics("Track", "Artist");

    expect(gateway.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req-1",
      cache: "disabled",
      status: "unavailable",
      errorCode: "timeout",
      retryable: true,
    }), "Lyrics lookup finished");
  });

  it("caches a confirmed not-found as null", async () => {
    lookupSyncedLyricsMock.mockResolvedValue(notFound());
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: setSpy } as unknown as LyricsCacheStore;
    const gateway = createGatewayWithCache(cache);

    expect(await gateway.resolveSyncedLyrics("Track", "Artist")).toEqual({ status: "not_found" });
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledWith("v3|track|artist|", null));
  });

  it("never caches an outage as \"no lyrics\"", async () => {
    lookupSyncedLyricsMock.mockResolvedValue(unavailable());
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const cache = { get: vi.fn().mockResolvedValue(undefined), set: setSpy } as unknown as LyricsCacheStore;
    const gateway = createGatewayWithCache(cache);

    expect(await gateway.resolveSyncedLyrics("Track", "Artist")).toEqual({ status: "unavailable", retryable: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("works without a cache store at all — always fetches from LRCLIB", async () => {
    lookupSyncedLyricsMock.mockResolvedValue(notFound());
    const gateway = createGatewayWithCache(null);

    const result = await gateway.resolveSyncedLyrics("Track", "Artist");

    expect(result).toEqual({ status: "not_found" });
    expect(lookupSyncedLyricsMock).toHaveBeenCalledWith("Track", "Artist", undefined, expect.anything());
  });
});

describe("LavalinkPlayerGateway trackStart lyrics handling", () => {
  beforeEach(() => {
    lookupSyncedLyricsMock.mockReset();
  });

  it("ignores an old failed request after returning to the same track", async () => {
    const { gateway } = createGateway(null);
    let rejectFirst!: (error: Error) => void;
    lookupSyncedLyricsMock
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(found([{ timestampMs: 0, line: "Fresh lyrics" }]));
    const first = { encoded: "track-a", info: { title: "A", author: "Artist" }, userData: {} };
    const second = { encoded: "track-b", info: { title: "B", author: "Artist" }, userData: {} };
    const player = {
      guildId, position: 0, queue: { current: first },
      subscribeLyrics: vi.fn().mockResolvedValue(undefined), get: vi.fn(),
    };
    const internals = gateway as unknown as {
      manager: { getPlayer: () => typeof player; emit: (event: string, ...args: unknown[]) => void };
      customLyricsByGuild: Map<string, unknown>;
    };
    internals.manager.getPlayer = (): typeof player => player;
    internals.manager.emit("trackStart", player, first);
    player.queue.current = second;
    internals.manager.emit("trackStart", player, second);
    player.queue.current = first;
    internals.manager.emit("trackStart", player, first);
    await vi.waitFor(() => expect(internals.customLyricsByGuild.get(guildId))
      .toEqual([{ timestampMs: 0, line: "Fresh lyrics" }]));
    rejectFirst(new Error("Old request failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internals.customLyricsByGuild.get(guildId))
      .toEqual([{ timestampMs: 0, line: "Fresh lyrics" }]);
  });

  it("doesn't re-clear or re-fetch lyrics when trackStart fires again for the same track", async () => {
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;
    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
    );

    const fetchedLines = [{ timestampMs: 0, line: "Hello" }];
    lookupSyncedLyricsMock.mockResolvedValue(found(fetchedLines));

    const track = {
      encoded: "same-track-encoded",
      info: { title: "Track", author: "Artist" },
      userData: {},
    };
    const player = {
      guildId,
      position: 0,
      queue: { current: track },
      subscribeLyrics: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => undefined),
    };

    const manager = (
      gateway as unknown as {
        manager: {
          getPlayer: (id: string) => typeof player | undefined;
          emit: (event: string, ...args: unknown[]) => void;
        };
      }
    ).manager;
    manager.getPlayer = vi.fn(() => player);

    const customLyricsByGuild = (
      gateway as unknown as { customLyricsByGuild: Map<string, unknown> }
    ).customLyricsByGuild;

    manager.emit("trackStart", player, track);
    await vi.waitFor(() => expect(customLyricsByGuild.get(guildId)).toEqual(fetchedLines));
    expect(lookupSyncedLyricsMock).toHaveBeenCalledOnce();

    // A duplicate event for the exact same track (e.g. a resolve-error retry
    // replaying it) — must not wipe the already-resolved lyrics or re-fetch.
    manager.emit("trackStart", player, track);
    await Promise.resolve();

    expect(lookupSyncedLyricsMock).toHaveBeenCalledOnce();
    expect(customLyricsByGuild.get(guildId)).toEqual(fetchedLines);
  });

  it("publishes a state-change event once lyrics finish loading, so the panel doesn't wait for its next unrelated tick", async () => {
    // Regression: the panel only refreshed on its own timer, which — right
    // after trackStart — had no lyrics yet to schedule a fast tick from, so
    // it fell back to the full ~3s cadence. Freshly-loaded lyrics could then
    // sit unshown for up to that whole interval on top of however long the
    // LRCLIB fetch itself took.
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const publish = vi.fn(() => Promise.resolve());
    const eventBus = { publish } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;
    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
    );

    lookupSyncedLyricsMock.mockResolvedValue(found([{ timestampMs: 0, line: "Hello" }]));

    const track = {
      encoded: "lyrics-loaded-track",
      info: { title: "Track", author: "Artist" },
      userData: {},
    };
    const player = {
      guildId,
      position: 0,
      queue: { current: track },
      subscribeLyrics: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => undefined),
    };
    const manager = (
      gateway as unknown as {
        manager: {
          getPlayer: (id: string) => typeof player | undefined;
          emit: (event: string, ...args: unknown[]) => void;
        };
      }
    ).manager;
    manager.getPlayer = vi.fn(() => player);

    manager.emit("trackStart", player, track);

    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ guildId, reason: "lyrics_loaded" }),
    ));
  });

  it("publishes a state-change event even when the LRCLIB fetch fails, so the panel still learns lyrics settled to not-found", async () => {
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const publish = vi.fn(() => Promise.resolve());
    const eventBus = { publish } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;
    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
    );

    lookupSyncedLyricsMock.mockResolvedValue(unavailable());

    const track = {
      encoded: "lyrics-failed-track",
      info: { title: "Track", author: "Artist" },
      userData: {},
    };
    const player = {
      guildId,
      position: 0,
      queue: { current: track },
      subscribeLyrics: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => undefined),
    };
    const manager = (
      gateway as unknown as {
        manager: {
          getPlayer: (id: string) => typeof player | undefined;
          emit: (event: string, ...args: unknown[]) => void;
        };
      }
    ).manager;
    manager.getPlayer = vi.fn(() => player);

    manager.emit("trackStart", player, track);

    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ guildId, reason: "lyrics_loaded" }),
    ));
  });

  it("keeps showing the current line well past the last line's own timestamp instead of going blank", () => {
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;
    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
    );

    const track = {
      encoded: "track-encoded",
      info: { title: "Track", author: "Artist", uri: "https://example.com", duration: 240_000 },
      userData: {},
    };
    // Lines 5s apart — well beyond the old 1s trailing window that used to
    // blank "current" out between them.
    const lines = [
      { timestampMs: 0, line: "First line" },
      { timestampMs: 5_000, line: "Second line" },
    ];
    const player = {
      guildId,
      // 4s past "First line" (and before "Second line" at 5s) — the exact
      // gap the old windowed logic would have gone blank for.
      position: 4_000,
      paused: false,
      playing: true,
      volume: 75,
      voiceChannelId: "voice-id",
      repeatMode: "off",
      queue: { current: track, tracks: [], previous: [] },
      get: (): undefined => undefined,
    };

    const manager = (
      gateway as unknown as { manager: { getPlayer: (id: string) => typeof player | undefined } }
    ).manager;
    manager.getPlayer = vi.fn(() => player);
    (
      gateway as unknown as { customLyricsByGuild: Map<string, unknown> }
    ).customLyricsByGuild.set(guildId, lines);

    const snapshot = gateway.getSnapshot(guildId);

    // While playing, selection is biased 500ms forward (editLatencyBiasMs)
    // to compensate for the edit's own network round trip — so at 4.0s the
    // line picked is really for a render position of 4.5s.
    expect(snapshot?.currentLyricLine).toBe("First line");
    expect(snapshot?.lyricsUnavailable).toBe(false);
    expect(snapshot?.nextLyricLineInMs).toBe(500);

    // 4.8s + the 500ms bias = past the 5s boundary — while playing, this
    // correctly flips early (by design: the edit reaching Discord will lag
    // behind by roughly that same amount).
    player.position = 4_800;
    expect(gateway.getSnapshot(guildId)?.currentLyricLine).toBe("Second line");
    expect(gateway.getSnapshot(guildId)?.nextLyricLineInMs).toBeNull();

    // The bias must not apply while paused — nothing is advancing to "catch
    // up" to, so biasing forward would show a line that hasn't started yet.
    player.position = 4_800;
    player.paused = true;
    expect(gateway.getSnapshot(guildId)?.currentLyricLine).toBe("First line");
    expect(gateway.getSnapshot(guildId)?.nextLyricLineInMs).toBe(200);

    player.position = 5_000;
    expect(gateway.getSnapshot(guildId)?.currentLyricLine).toBe("Second line");
    expect(gateway.getSnapshot(guildId)?.nextLyricLineInMs).toBeNull();
  });

  it("previews the first line even during a long intro well past the lookahead window", () => {
    // Regression: a first line more than lyricsLookaheadMs (4s) away used to
    // leave "upcoming" empty, so a track with a long intro showed "Looking
    // for lyrics…" — indistinguishable from lyrics not having loaded at all
    // — for however long that intro lasted, even though the full line list
    // was already resolved and sitting in memory.
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;
    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
    );

    const track = {
      encoded: "track-encoded",
      info: { title: "Track", author: "Artist", uri: "https://example.com", duration: 240_000 },
      userData: {},
    };
    // A 15s intro before the first line, well past the 4s lookahead window.
    const lines = [
      { timestampMs: 15_000, line: "First line" },
      { timestampMs: 20_000, line: "Second line" },
    ];
    const player = {
      guildId,
      position: 0,
      paused: false,
      playing: true,
      volume: 75,
      voiceChannelId: "voice-id",
      repeatMode: "off",
      queue: { current: track, tracks: [], previous: [] },
      get: (): undefined => undefined,
    };

    const manager = (
      gateway as unknown as { manager: { getPlayer: (id: string) => typeof player | undefined } }
    ).manager;
    manager.getPlayer = vi.fn(() => player);
    (
      gateway as unknown as { customLyricsByGuild: Map<string, unknown> }
    ).customLyricsByGuild.set(guildId, lines);

    const snapshot = gateway.getSnapshot(guildId);
    expect(snapshot?.currentLyricLine).toBeNull();
    expect(snapshot?.upcomingLyricLines).toEqual(["First line"]);
    // While playing, position is biased 500ms forward (editLatencyBiasMs).
    expect(snapshot?.nextLyricLineInMs).toBe(15_000 - 500);
  });

  it("reports lyrics as unavailable once our own fetch confirms not-found, without waiting on the plugin fallback to also settle", () => {
    const client = { guilds: { cache: new Map<string, Guild>() } } as unknown as Client;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const eventBus = { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus;
    const guildConfigurationProvider = { find: vi.fn(() => undefined) } as unknown as GuildConfigurationProvider;
    const gateway = new LavalinkPlayerGateway(
      client,
      { host: "localhost", port: 2333, password: "pw", secure: false },
      logger as never,
      eventBus,
      guildConfigurationProvider,
    );

    const track = {
      encoded: "track-encoded",
      info: { title: "Track", author: "Artist", uri: "https://example.com", duration: 240_000 },
      userData: {},
    };
    const player = {
      guildId,
      position: 1_000,
      paused: false,
      playing: true,
      volume: 75,
      voiceChannelId: "voice-id",
      repeatMode: "off",
      queue: { current: track, tracks: [], previous: [] },
      get: (): undefined => undefined,
    };

    const manager = (
      gateway as unknown as { manager: { getPlayer: (id: string) => typeof player | undefined } }
    ).manager;
    manager.getPlayer = vi.fn(() => player);
    // Our own LRCLIB fetch has settled on "not-found" — the plugin fallback
    // (pluginLyricsByGuild) is left completely unset, as it would be if it
    // never fires any event at all for this track.
    (
      gateway as unknown as { customLyricsByGuild: Map<string, unknown> }
    ).customLyricsByGuild.set(guildId, "not-found");

    const snapshot = gateway.getSnapshot(guildId);

    expect(snapshot?.currentLyricLine).toBeNull();
    expect(snapshot?.lyricsUnavailable).toBe(true);
  });
});
