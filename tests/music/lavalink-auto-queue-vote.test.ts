import type { ButtonStyle, Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  autoQueueVoteClosesAtSeconds,
  createAutoQueueVotePayload,
  parseAutoQueueVoteCustomId,
  type ReadyAutoQueueVote,
} from "../../src/application/control-panel/auto-queue-vote-message.js";
import {
  MusicAutoQueueRerollEmptyError,
  MusicAutoQueueRerollLimitError,
  MusicAutoQueueVoteClosedError,
  MusicAutoQueueVoteUnavailableError,
} from "../../src/application/music/music-errors.js";
import type { MusicEventBus } from "../../src/application/music/music-event-bus.js";
import type { MusicPlayerSnapshot } from "../../src/application/music/music-player-gateway.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { texts } from "../../src/application/i18n/texts.js";
import { renderVoteBar } from "../../src/application/polls/vote-bar.js";
import { LavalinkAutoQueue } from "../../src/infrastructure/lavalink/lavalink-auto-queue.js";
import { LavalinkPlayerGateway } from "../../src/infrastructure/lavalink/lavalink-player-gateway.js";

// Only "Song a" has synced lyrics.
vi.mock("../../src/infrastructure/lyrics/synced-lyrics-client.js", () => ({
  lookupSyncedLyrics: (title: string): Promise<unknown> => Promise.resolve({
    result: title === "Song a"
      ? { status: "found", lines: [{ timestampMs: 0, line: "la" }], source: "lrclib" }
      : { status: "not_found" },
    attempts: [],
  }),
  lyricsCacheIdentity: (title: string, artist: string): unknown => ({ title, artist }),
}));

const guildId = "123456789012345678";

interface TestTrack {
  encoded: string;
  info: { identifier: string; title: string; author: string; uri: string; sourceName: string; duration: number };
  userData?: Record<string, unknown>;
}

function track(identifier: string, author = "Artist"): TestTrack {
  return {
    encoded: `encoded-${identifier}`,
    info: {
      identifier,
      title: `Song ${identifier}`,
      author,
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
    const related = ["a", "b", "c", "d", "e", "f", "g"].map((id) => track(id));
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

    await gateway.rerollAutoQueueVote(guildId, "user-2", "similar");

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

  it("locks voting for the last 10 seconds, following playback position", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c"), track("d"), track("e")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    player.position = 169_000;
    const open = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(open?.status === "ready" && [open.locked, open.closesInMs]).toEqual([false, 1_000]);

    player.position = 171_000;
    const locked = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(locked?.status === "ready" && locked.locked).toBe(true);
    expect(() => gateway.voteAutoQueue(guildId, "user-1", 1)).toThrow(MusicAutoQueueVoteClosedError);
    await expect(gateway.rerollAutoQueueVote(guildId, "user-1", "similar")).rejects.toThrow(MusicAutoQueueVoteClosedError);

    // Seeking back reopens it.
    player.position = 60_000;
    expect(() => gateway.voteAutoQueue(guildId, "user-1", 1)).not.toThrow();
  });

  it("skips the vote when under 30 seconds of the track are left, and autoqueue still picks", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    player.position = 155_000;
    const gateway = createGateway(player);
    await gateway.toggleAutoQueue(guildId);

    expect(gateway.getSnapshot(guildId)?.autoQueueVote).toBeNull();
    expect(player.search).not.toHaveBeenCalled();

    await gateway.skip(guildId);
    expect(player.queue.tracks[0]?.info.identifier).toBe("a");
  });

  it("rerolls into other songs by the current artist, ignoring other artists", async () => {
    const player = createPlayer(track("source", "Artist - Topic"), [
      track("a"), track("b"), track("c"), track("x", "Someone Else"), track("d", "ArtistVEVO"), track("e"),
    ]);
    const gateway = createGateway(player);
    await openVote(gateway);

    await gateway.rerollAutoQueueVote(guildId, "user-2", "artist");

    expect(player.search).toHaveBeenLastCalledWith({ query: "Artist", source: "spsearch" }, { userId: "autoqueue" });
    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && vote.options.map((option) => option.title)).toEqual(["Song d", "Song e"]);
  });

  it("caps rerolls per vote and records who rerolled", async () => {
    const related = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => track(id));
    const player = createPlayer(track("source"), related);
    const gateway = createGateway(player);
    await openVote(gateway);

    for (const userId of ["user-1", "user-2", "user-3"]) {
      await gateway.rerollAutoQueueVote(guildId, userId, "similar");
    }
    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && [vote.rerollsLeft, vote.lastRerolledByUserId]).toEqual([0, "user-3"]);
    await expect(gateway.rerollAutoQueueVote(guildId, "user-1", "artist")).rejects.toThrow(MusicAutoQueueRerollLimitError);
  });

  it("keeps the current options when a reroll finds nothing new", async () => {
    const player = createPlayer(track("source"), [track("a"), track("b"), track("c")]);
    const gateway = createGateway(player);
    await openVote(gateway);

    await expect(gateway.rerollAutoQueueVote(guildId, "user-2", "similar")).rejects.toThrow(MusicAutoQueueRerollEmptyError);

    const vote = gateway.getSnapshot(guildId)?.autoQueueVote;
    expect(vote?.status === "ready" && vote.options.map((option) => option.title)).toEqual(["Song a", "Song b", "Song c"]);
  });
});

describe("autoqueue vote message", () => {
  const profile = { embedColor: "#5865F2", language: "en", music: { autoQueueVoteBarStyle: "squares" } } as GuildConfiguration;
  const context = { closesAtSeconds: 1_700_000_000, paused: false, currentArtist: "Artist" };
  const voteWith = (
    count: number,
    overrides: Partial<ReadyAutoQueueVote> = {},
  ): ReadyAutoQueueVote => ({
    status: "ready",
    leadingIndex: 0,
    locked: false,
    closesInMs: 60_000,
    rerollsLeft: 3,
    lastRerolledByUserId: null,
    options: Array.from({ length: count }, (_, index) => ({
      title: `Song ${index}`, author: "Artist", uri: "", votes: 0, lyricsAvailable: null,
    })),
    ...overrides,
  });
  const buttonsOf = (payload: ReturnType<typeof createAutoQueueVotePayload>): Array<Array<{
    style: ButtonStyle; label: string; disabled?: boolean;
  }>> => payload.components.map((row) => row.toJSON().components as Array<{ style: ButtonStyle; label: string; disabled?: boolean }>);

  it("round-trips its button ids", () => {
    expect(parseAutoQueueVoteCustomId("music-vote:v1:option-2")).toEqual({ kind: "option", index: 2 });
    expect(parseAutoQueueVoteCustomId("music-vote:v1:reroll")).toEqual({ kind: "reroll", mode: "similar" });
    expect(parseAutoQueueVoteCustomId("music-vote:v1:reroll-artist")).toEqual({ kind: "reroll", mode: "artist" });
    expect(parseAutoQueueVoteCustomId("music-panel:v1:skip")).toBeNull();
  });

  it("keeps the text short: options, bars and one footer line", () => {
    const payload = createAutoQueueVotePayload(profile, voteWith(3, {
      leadingIndex: 1,
      options: [
        { title: "One", author: "A - Topic", uri: "", votes: 0, lyricsAvailable: false },
        { title: "Two", author: "B", uri: "", votes: 2, lyricsAvailable: true },
        { title: "Three", author: "C", uri: "", votes: 1, lyricsAvailable: null },
      ],
    }), context);

    expect(payload.embeds[0]!.toJSON().title).toBe("🗳️ Up next");
    expect(payload.embeds[0]!.toJSON().description).toBe([
      "1️⃣ One — A",
      "⬛⬛⬛⬛⬛⬛⬛⬛ 0",
      "▶ **2️⃣ Two** — B 🎤",
      "🟩🟩🟩🟩🟩⬛⬛⬛ **2**",
      "3️⃣ Three — C",
      "🟦🟦🟦⬛⬛⬛⬛⬛ 1",
      "-# Closes at <t:1700000000:t> · 🎲 3 left",
    ].join("\n"));
  });

  it("shows who rerolled, and when paused or streaming, in the footer", () => {
    const describe = (overrides: Partial<ReadyAutoQueueVote>, paused = false, closesAtSeconds: number | null = 1): string =>
      createAutoQueueVotePayload(profile, voteWith(2, overrides), { ...context, paused, closesAtSeconds })
        .embeds[0]!.toJSON().description!.split("\n").at(-1)!;

    expect(describe({ lastRerolledByUserId: "42", rerollsLeft: 2 })).toBe("-# Closes at <t:1:t> · 🎲 <@42> rerolled · 2 left");
    expect(describe({}, true, null)).toBe("-# Paused · 🎲 3 left");
    expect(describe({}, false, null)).toBe("-# Open until skip · 🎲 3 left");
  });

  it("renders in the server language", () => {
    const ja = texts.ja.music.vote;
    const payload = createAutoQueueVotePayload({ ...profile, language: "ja" }, voteWith(2), { ...context, currentArtist: "" });
    const embed = payload.embeds[0]!.toJSON();
    const labels = buttonsOf(payload).at(-1)!.map((button) => button.label);

    expect(embed.title).toBe(ja.title);
    expect(embed.description).toContain(ja.closes({ time: "<t:1700000000:t>" }));
    expect(embed.description).toContain(ja.rerollsLeft({ count: 3 }));
    expect(labels).toEqual([ja.similar, ja.sameArtist]);
    expect(embed.title).not.toBe("🗳️ Up next");
  });

  it("puts rerolls on their own row below the options, wrapping 6 options onto two rows", () => {
    const rowSizes = (count: number): number[] => buttonsOf(createAutoQueueVotePayload(profile, voteWith(count), context))
      .map((row) => row.length);

    expect(rowSizes(2)).toEqual([2, 2]);
    expect(rowSizes(5)).toEqual([5, 2]);
    expect(rowSizes(6)).toEqual([5, 1, 2]);
    const rerollRow = buttonsOf(createAutoQueueVotePayload(profile, voteWith(3), context)).at(-1)!;
    expect(rerollRow.map((button) => button.label)).toEqual(["Similar", "Artist"]);
  });

  it("disables everything and drops the footer once locked", () => {
    const payload = createAutoQueueVotePayload(profile, voteWith(3, { locked: true }), context);

    expect(payload.embeds[0]!.toJSON().title).toBe("🔒 Up next");
    expect(payload.embeds[0]!.toJSON().description).not.toContain("-#");
    expect(buttonsOf(payload).flat().every((button) => button.disabled)).toBe(true);
  });

  it("disables only the reroll row once rerolls run out", () => {
    const rows = buttonsOf(createAutoQueueVotePayload(profile, voteWith(3, { rerollsLeft: 0 }), context));

    expect(rows[0]!.some((button) => button.disabled)).toBe(false);
    expect(rows.at(-1)!.every((button) => button.disabled)).toBe(true);
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

  it("counts down to the lock, with no countdown while paused, locked or streaming", () => {
    expect(autoQueueVoteClosesAtSeconds(voteWith(2, { closesInMs: 120_000 }), false, 0)).toBe(120);
    expect(autoQueueVoteClosesAtSeconds(voteWith(2), true, 0)).toBeNull();
    expect(autoQueueVoteClosesAtSeconds(voteWith(2, { locked: true }), false, 0)).toBeNull();
    expect(autoQueueVoteClosesAtSeconds(voteWith(2, { closesInMs: null }), false, 0)).toBeNull();
  });
});
