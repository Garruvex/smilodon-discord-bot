import type { GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { MusicVoiceChannelRequiredError } from "../../../src/application/music/music-errors.js";
import type { PlaybackService } from "../../../src/application/music/playback-service.js";
import { MusicPlayTool } from "../../../src/application/chat/tools/music-play-tool.js";
import { MusicControlTool } from "../../../src/application/chat/tools/music-control-tool.js";
import { MusicVolumeTool } from "../../../src/application/chat/tools/music-volume-tool.js";
import type { ChatToolContext } from "../../../src/application/chat/tools/chat-tool.js";

function contextWithoutMusic(): ChatToolContext {
  return {
    guildId: "guild-1",
    currentUser: { id: "user-1", displayName: "Tester", roleNames: [] },
    channelIsNsfw: false,
    music: null,
  };
}

function fakeMember(roleIds: readonly string[]): GuildMember {
  return {
    roles: { cache: { some: (predicate: (role: { id: string }) => boolean) => roleIds.some((id) => predicate({ id })) } },
  } as unknown as GuildMember;
}

function contextWithMusic(volumeMaximum = 150): ChatToolContext {
  return {
    guildId: "guild-1",
    currentUser: { id: "user-1", displayName: "Tester", roleNames: [] },
    channelIsNsfw: false,
    music: {
      actor: { guildId: "guild-1", textChannelId: "channel-1", userId: "user-1", member: fakeMember(["role-controller"]) },
      volumeMaximum,
      musicControllerRoleIds: new Set(["role-controller"]),
      botAdministratorRoleIds: new Set(),
    },
  };
}

describe("MusicPlayTool", () => {
  it("refuses when the caller can't control music", async () => {
    const enqueue = vi.fn();
    const playbackService = { enqueue } as unknown as PlaybackService;
    const tool = new MusicPlayTool(playbackService);
    const result = await tool.execute({ query: "some song" }, contextWithoutMusic());
    expect(result.content).toMatch(/music-controller role/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues and reports the result when allowed", async () => {
    const enqueue = vi.fn(() => Promise.resolve({
      firstTrack: { title: "Affection", author: "Jinsang" },
      addedTrackCount: 1,
      startedPlayback: true,
      queuePosition: null,
    }));
    const playbackService = { enqueue } as unknown as PlaybackService;
    const tool = new MusicPlayTool(playbackService);
    const ctx = contextWithMusic();
    const result = await tool.execute({ query: "Jinsang Affection" }, ctx);
    expect(enqueue).toHaveBeenCalledWith(ctx.music!.actor, "Jinsang Affection");
    expect(JSON.parse(result.content)).toMatchObject({ title: "Affection", author: "Jinsang", startedPlayback: true });
  });

  it("surfaces a music error's message instead of throwing", async () => {
    const playbackService = {
      enqueue: vi.fn(() => Promise.reject(new MusicVoiceChannelRequiredError())),
    } as unknown as PlaybackService;
    const tool = new MusicPlayTool(playbackService);
    const result = await tool.execute({ query: "some song" }, contextWithMusic());
    expect(result.content).toBe("You're not in a voice channel! Join one, then try this command again.");
  });

  it("rechecks the role gate on every call rather than trusting a stale resolution", async () => {
    const enqueue = vi.fn();
    const playbackService = { enqueue } as unknown as PlaybackService;
    const tool = new MusicPlayTool(playbackService);
    const ctx = contextWithMusic();
    // Same ChatToolContext object as a normal allowed call, but the member's
    // live role set no longer includes the controller role — simulates a
    // role change mid-turn, which a single once-per-turn check would miss.
    ctx.music!.actor.member = fakeMember(["role-unrelated"]);
    const result = await tool.execute({ query: "some song" }, ctx);
    expect(result.content).toMatch(/music-controller role/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("MusicControlTool", () => {
  it("dispatches to the matching PlaybackService method", async () => {
    const skip = vi.fn(() => Promise.resolve());
    const playbackService = { skip } as unknown as PlaybackService;
    const tool = new MusicControlTool(playbackService);
    const ctx = contextWithMusic();
    const result = await tool.execute({ action: "skip" }, ctx);
    expect(skip).toHaveBeenCalledWith(ctx.music!.actor);
    expect(result.content).toBe("skip succeeded.");
  });

  it("refuses when the caller can't control music", async () => {
    const pause = vi.fn();
    const playbackService = { pause } as unknown as PlaybackService;
    const tool = new MusicControlTool(playbackService);
    const result = await tool.execute({ action: "pause" }, contextWithoutMusic());
    expect(result.content).toMatch(/music-controller role/);
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("MusicVolumeTool", () => {
  it("clamps the requested volume to the guild's configured maximum", async () => {
    const setVolume = vi.fn(() => Promise.resolve());
    const playbackService = { setVolume } as unknown as PlaybackService;
    const tool = new MusicVolumeTool(playbackService);
    const ctx = contextWithMusic(100);
    const result = await tool.execute({ volume: 250 }, ctx);
    expect(setVolume).toHaveBeenCalledWith(ctx.music!.actor, 100, 100);
    expect(result.content).toBe("Volume set to 100.");
  });
});
