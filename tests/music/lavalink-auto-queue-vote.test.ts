import { ButtonStyle, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  autoQueueVoteClosesAtSeconds,
  createAutoQueueVotePayload,
  parseAutoQueueVoteCustomId,
} from "../../src/application/control-panel/auto-queue-vote-message.js";
import {
  MusicAutoQueueRerollEmptyError,
  MusicAutoQueueVoteUnavailableError,
} from "../../src/application/music/music-errors.js";
import type { MusicEventBus } from "../../src/application/music/music-event-bus.js";
import type { MusicPlayerSnapshot } from "../../src/application/music/music-player-gateway.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { renderVoteBar } from "../../src/application/polls/vote-bar.js";
import { LavalinkAutoQueue } from "../../src/infrastructure/lavalink/lavalink-auto-queue.js";
import { LavalinkPlayerGateway } from "../../src/infrastructure/lavalink/lavalink-player-gateway.js";

// Only "Song a" has synced lyrics.
vi.mock("../../src/infrastructure/lyrics/lrclib-client.js", () => ({
  fetchSyncedLyrics: (title: string): Promise<unknown> =>
    Promise.resolve(title === "Song a" ? [{ timestampMs: 0, line: "la" }] : null),
  normalizeQuery: (title: string, artist: string): unknown => ({ title, artist, extraArtist: null }),
}));

const guildId = "123456789012345678";

interface TestTrack {
  encoded: string;
  info: { identifier: string; title: string; author: string; uri: string; sourceName: string; duration: number };
  userData?: Record<string, unknown>;
}

function track(identifier: string): TestTrack {
  return {
    encoded: `encoded-${identifier}`,
    info: {
      identifier,
      title: `Song ${identifier}`,
      author: "Artist",
      uri: `https://example.com/${identifier}`,
      sourceName: "youtube",
      duration: 180_000,
    },
  };
}

function createPlayer(current: TestTrack, related: TestTrack[]): Record<string, unknown> & {
  queue: { current: TestTrack | null; tracks: TestTrack[]; previous: TestTrack[]; add: ReturnType<typeof vi.fn> };
  search: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, unknown>();
  const queue = {
    current: current as TestTrack | null,
    tracks: [] as TestTrack[],
    previous: [] as TestTrack[],
    add: vi.fn((added: TestTrack) => {
      queue.tracks.push(added);
      return Promise.resolve();
    }),
  };
  return {
    guildId,
    voiceChannelId: "voice-id",
    paused: false,
    playing: true,
    volume: 100,
    position: 0,
    repeatMode: "off",
    queue,
    get: (key: string): unknown => values.get(key),
    set: (key: string, value: unknown): void => {
      values.set(key, value);
    },
    search: vi.fn().mockResolvedValue({ tracks: related }),
    skip: vi.fn(() => Promise.resolve()),
  };
}

function createGateway(
  player: ReturnType<typeof createPlayer>,
  voteEnabled = true,
  optionCount = 3,
): LavalinkPlayerGateway {
  const gateway = new LavalinkPlayerGateway(
    { guilds: { cache: new Map() } } as unknown as Client,
    { host: "localhost", port: 2333, password: "pw", secure: false },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    { publish: vi.fn(() => Promise.resolve()) } as unknown as MusicEventBus,
    { find: vi.fn(() => ({ music: { autoQueueVoteEnabled: voteEnabled, autoQueueVoteOptionCount: optionCount } })) } as unknown as GuildConfigurationProvider,
  );
  (gateway as unknown as { manager: { getPlayer: () => unknown } }).manager.getPlayer = vi.fn(() => player);
  return gateway;
}

async function openVote(
  gateway: LavalinkPlayerGateway,
): Promise<Extract<MusicPlayerSnapshot["autoQueueVote"], { status: "ready" }>> {
  await gateway.toggleAutoQueue(guildId);
  await vi.waitFor(() => expect(gateway.getSnapshot(guildId)?.autoQueueVote?.status).toBe("ready"));
  const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
  if (vote?.status !== "ready") throw new Error("vote did not open");
  return vote;
}

describe("LavalinkAutoQueue.findCandidates", () => {
  it("returns up to the requested number of unplayed, distinct tracks in ranked order", async () => {
    const source = track("source");
    const player = createPlayer(source, [source, track("a"), track("a"), track("b"), track("c"), track("d")]);

    const outcome = await new LavalinkAutoQueue().findCandidates(player as never, source as never, 3);

    expect(outcome.status).toBe("found");
    expect(outcome.status === "found" && outcome.tracks.map((t) => t.info.identifier)).toEqual(["a", "b", "c"]);
  });

  it("skips explicitly excluded identifiers, for rerolls", async () => {
    const source = track("source");
    const player = createPlayer(source, [track("a"), track("b"), track("c"), track("d")]);

    const outcome = await new LavalinkAutoQueue().findCandidates(player as never, source as never, 3, ["a", "b"]);

    expect(outcome.status === "found" && outcome.tracks.map((t) => t.info.identifier)).toEqual(["c", "d"]);
  });
});

describe("LavalinkPlayerGateway autoqueue vote", () => {
  it("opens a vote with three options once autoqueue is on and nothing is queued", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c"), track("d")]);
    const vote = await openVote(createGateway(player));

    expect(vote.options.map((option) => option.title)).toEqual(["Song a", "Song b", "Song c"]);
    expect(vote.leadingIndex).toBe(0);
  });

  it("offers as many options as the server's setting asks for", async () => {
    const related = ["a", "b", "c", "d", "e", "f", "g"].map(track);
    const five = await openVote(createGateway(createPlayer(track("source"), related), true, 5));
    const two = await openVote(createGateway(createPlayer(track("source"), related), true, 2));

    expect(five.options).toHaveLength(5);
    expect(two.options.map((option) => option.title)).toEqual(["Song a", "Song b"]);
  });

  it("queues option 1 on skip when nobody voted", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    await gateway.skip(guildId);

    expect(player.queue.add).toHaveBeenCalledOnce();
    expect(player.queue.tracks[0]?.info.identifier).toBe("a");
    expect(player.queue.tracks[0]?.userData?.requestedByUserId).toBe("autoqueue");
  });

  it("queues the most-voted option, breaking ties toward the earlier one", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    gateway.voteAutoQueue(guildId, "user-1", 2);
    gateway.voteAutoQueue(guildId, "user-2", 1);
    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && vote.leadingIndex).toBe(1);

    gateway.voteAutoQueue(guildId, "user-3", 2);
    await gateway.skip(guildId);

    expect(player.queue.tracks[0]?.info.identifier).toBe("c");
  });

  it("withdraws a vote when the same option is picked again, and moves it otherwise", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    expect(gateway.voteAutoQueue(guildId, "user-1", 1)).toBe(1);
    expect(gateway.voteAutoQueue(guildId, "user-1", 2)).toBe(2);
    expect(gateway.voteAutoQueue(guildId, "user-1", 2)).toBeNull();
    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && vote.options.map((option) => option.votes)).toEqual([0, 0, 0]);
  });

  it("hides the vote while something is queued by hand and rejects votes then", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    player.queue.tracks.push(track("manual"));

    expect(gateway.getSnapshot(guildId)?.autoQueueVote).toBeNull();
    expect(() => gateway.voteAutoQueue(guildId, "user-1", 0)).toThrow(MusicAutoQueueVoteUnavailableError);
  });

  it("rerolls into fresh options and clears the votes", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c"), track("d"), track("e")]);
    const gateway = createGateway(player);
    await openVote(gateway);
    gateway.voteAutoQueue(guildId, "user-1", 1);

    await gateway.rerollAutoQueueVote(guildId);

    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && vote.options.map((option) => option.title)).toEqual(["Song d", "Song e"]);
    expect(vote?.status === "ready" && vote.options.every((option) => option.votes === 0)).toBe(true);
  });

  it("marks which options have synced lyrics once the lookups finish", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    await vi.waitFor(() => {
      const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
      expect(vote?.status === "ready" && vote.options.map((option) => option.lyricsAvailable))
        .toEqual([true, false, false]);
    });
  });

  it("runs plain autoqueue with no vote when the vote setting is off", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player, false);
    await gateway.toggleAutoQueue(guildId);

    expect(gateway.getSnapshot(guildId)?.autoQueueVote).toBeNull();
    expect(() => gateway.voteAutoQueue(guildId, "user-1", 1)).toThrow(MusicAutoQueueVoteUnavailableError);

    await gateway.skip(guildId);
    expect(player.queue.tracks[0]?.info.identifier).toBe("a");
  });

  it("keeps the current options when a reroll finds nothing new", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    await expect(gateway.rerollAutoQueueVote(guildId)).rejects.toThrow(MusicAutoQueueRerollEmptyError);

    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && vote.options.map((option) => option.title)).toEqual(["Song a", "Song b", "Song c"]);
  });
});

describe("autoqueue vote message", () => {
  const profile = { embedColor: "#5865F2", music: { autoQueueVoteBarStyle: "squares" } } as GuildConfiguration;

  it("round-trips its button ids", () => {
    expect(parseAutoQueueVoteCustomId("music-vote:v1:option-2")).toEqual({ kind: "option", index: 2 });
    expect(parseAutoQueueVoteCustomId("music-vote:v1:reroll")).toEqual({ kind: "reroll" });
    expect(parseAutoQueueVoteCustomId("music-panel:v1:skip")).toBeNull();
  });

  it("highlights the leading option and adds a reroll button", () => {
    const payload = createAutoQueueVotePayload(profile, {
      status: "ready",
      leadingIndex: 1,
      options: [
        { title: "One", author: "A", uri: "", votes: 0, lyricsAvailable: false },
        { title: "Two", author: "B", uri: "", votes: 2, lyricsAvailable: true },
        { title: "Three", author: "C", uri: "", votes: 1, lyricsAvailable: null },
      ],
    }, 1_700_000_000);

    const buttons = payload.components[0]!.toJSON().components as Array<{ style: ButtonStyle; label: string }>;
    expect(buttons.map((button) => button.label)).toEqual(["0", "2", "1", "Reroll"]);
    expect(buttons.map((button) => button.style)).toEqual([
      ButtonStyle.Secondary, ButtonStyle.Success, ButtonStyle.Secondary, ButtonStyle.Secondary,
    ]);
    expect(payload.embeds[0]!.toJSON().description).toContain("<t:1700000000:R>");
    const description = payload.embeds[0]!.toJSON().description;
    expect(description).toContain("▶ **2️⃣ Two** — B 🎤 · up next\n🟩🟩🟩🟩🟩⬛⬛⬛  **2** votes");
    expect(description).toContain("1️⃣ One — A\n⬛⬛⬛⬛⬛⬛⬛⬛  0 votes");
    expect(description).toContain("3️⃣ Three — C\n🟦🟦🟦⬛⬛⬛⬛⬛  1 vote");
  });

  it("keeps up to 4 options and reroll on one row, wrapping 5 or 6 onto a second", () => {
    const voteWith = (count: number): Parameters<typeof createAutoQueueVotePayload>[1] => ({
      status: "ready",
      leadingIndex: 0,
      options: Array.from({ length: count }, (_, index) => ({
        title: `Song ${index}`, author: "Artist", uri: "", votes: 0, lyricsAvailable: null,
      })),
    });
    const rowSizes = (count: number): number[] => createAutoQueueVotePayload(profile, voteWith(count), null)
      .components.map((row) => row.toJSON().components.length);

    expect(rowSizes(2)).toEqual([3]);
    expect(rowSizes(4)).toEqual([5]);
    expect(rowSizes(5)).toEqual([5, 1]);
    expect(rowSizes(6)).toEqual([5, 2]);
  });

  it("draws vote bars as a share of all votes, green for the leader", () => {
    expect(renderVoteBar(0, 0, true)).toBe("⬛⬛⬛⬛⬛⬛⬛⬛");
    expect(renderVoteBar(3, 3, true)).toBe("🟩🟩🟩🟩🟩🟩🟩🟩");
    expect(renderVoteBar(1, 2, false)).toBe("🟦🟦🟦🟦⬛⬛⬛⬛");
    // One vote out of many still shows up.
    expect(renderVoteBar(1, 40, false)).toBe("🟦⬛⬛⬛⬛⬛⬛⬛");
  });

  it("draws the thin style like the progress bar, bolding the leader", () => {
    expect(renderVoteBar(1, 2, true, "thin")).toBe("**▰▰▰▰▰▰▱▱▱▱▱▱**");
    expect(renderVoteBar(1, 2, false, "thin")).toBe("▰▰▰▰▰▰▱▱▱▱▱▱");
  });

  it("has no countdown while paused", () => {
    const snapshot = {
      paused: true,
      currentTrack: { durationMs: 180_000, positionMs: 60_000, isStream: false },
    } as MusicPlayerSnapshot;
    expect(autoQueueVoteClosesAtSeconds(snapshot, 0)).toBeNull();
    expect(autoQueueVoteClosesAtSeconds({ ...snapshot, paused: false }, 0)).toBe(120);
  });
});
