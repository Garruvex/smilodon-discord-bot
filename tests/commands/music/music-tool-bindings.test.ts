import type { GuildConfiguration } from "../../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../src/config/guild-configuration-provider.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatToolContext } from "../../../src/application/chat/tools/chat-tool.js";
import { MusicVoiceChannelRequiredError } from "../../../src/application/music/music-errors.js";
import type { PlaybackService } from "../../../src/application/music/playback-service.js";
import { PauseCommand } from "../../../src/infrastructure/discord/commands/music/pause-command.js";
import { PlayCommand } from "../../../src/infrastructure/discord/commands/music/play-command.js";
import { VolumeCommand } from "../../../src/infrastructure/discord/commands/music/volume-command.js";

// Covers a command's toolBinding — i.e. the LLM-callable path — which now
// runs the exact same AccessPolicyEngine chain as the slash command (see
// music-tool-support.ts's evaluateMusicToolAccess), rather than a bespoke
// role-only check.

function resolveAccessSubjectFields(
  roleIds: readonly string[],
): () => { roleIds: readonly string[]; memberPermissions: bigint; botPermissions: bigint | null } {
  return () => ({ roleIds, memberPermissions: -1n, botPermissions: -1n });
}

function fakeProfiles(overrides: Partial<{
  musicEnabled: boolean;
  musicControllerRoleIds: readonly string[];
  maximumVolume: number;
}> = {}): GuildConfigurationProvider {
  const profile = {
    features: { music: overrides.musicEnabled ?? true },
    channels: { controlPanel: null, musicCommands: new Set<string>() },
    roles: {
      restricted: new Set<string>(),
      musicController: new Set(overrides.musicControllerRoleIds ?? ["role-controller"]),
      botAdministrator: new Set<string>(),
    },
    music: { maximumVolume: overrides.maximumVolume ?? 150, openQueueRequestsEnabled: false },
  } as unknown as GuildConfiguration;
  return { find: () => profile, require: () => profile } as unknown as GuildConfigurationProvider;
}

function contextWithoutMusic(): ChatToolContext {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    currentUser: { id: "user-1", displayName: "Tester", roleNames: [] },
    channelIsNsfw: false,
    channelMode: "shared",
    isOwner: false,
    music: null,
    pendingGeneratedImages: [],
  };
}

function contextWithMusic(roleIds: readonly string[] = ["role-controller"]): ChatToolContext {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    currentUser: { id: "user-1", displayName: "Tester", roleNames: [] },
    channelIsNsfw: false,
    channelMode: "shared",
    isOwner: false,
    music: {
      actor: { guildId: "guild-1", textChannelId: "channel-1", userId: "user-1", voiceChannelId: null, bypassVoiceChannelCheck: false, allowQueueWithoutVoiceChannel: false },
      resolveAccessSubjectFields: resolveAccessSubjectFields(roleIds),
      volumeMaximum: 150,
      musicControllerRoleIds: new Set(["role-controller"]),
      botAdministratorRoleIds: new Set(),
    },
    pendingGeneratedImages: [],
  };
}

describe("PlayCommand.toolBinding", () => {
  it("refuses when the caller has no resolvable music actor", async () => {
    const enqueue = vi.fn();
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, fakeProfiles());
    const result = await command.toolBinding.execute({ query: "some song" }, contextWithoutMusic());
    expect(result.content).toMatch(/music-controller role/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses when the caller lacks the musicController role", async () => {
    const enqueue = vi.fn();
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, fakeProfiles());
    const result = await command.toolBinding.execute({ query: "some song" }, contextWithMusic(["role-unrelated"]));
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
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, fakeProfiles());
    const ctx = contextWithMusic();
    const result = await command.toolBinding.execute({ query: "Jinsang Affection" }, ctx);
    expect(enqueue).toHaveBeenCalledWith(ctx.music!.actor, "Jinsang Affection");
    expect(JSON.parse(result.content)).toMatchObject({ title: "Affection", author: "Jinsang", startedPlayback: true });
  });

  it("surfaces a music error's message instead of throwing", async () => {
    const enqueue = vi.fn(() => Promise.reject(new MusicVoiceChannelRequiredError()));
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, fakeProfiles());
    const result = await command.toolBinding.execute({ query: "some song" }, contextWithMusic());
    expect(result.content).toBe("You're not in a voice channel! Join one, then try this command again.");
  });

  it("denies when the guild has music disabled", async () => {
    const enqueue = vi.fn();
    const command = new PlayCommand({ enqueue } as unknown as PlaybackService, fakeProfiles({ musicEnabled: false }));
    const result = await command.toolBinding.execute({ query: "some song" }, contextWithMusic());
    expect(result.content).toMatch(/music-controller role/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("PauseCommand.toolBinding", () => {
  it("dispatches to PlaybackService.pause when allowed", async () => {
    const pause = vi.fn(() => Promise.resolve());
    const command = new PauseCommand({ pause } as unknown as PlaybackService, fakeProfiles());
    const ctx = contextWithMusic();
    const result = await command.toolBinding.execute({}, ctx);
    expect(pause).toHaveBeenCalledWith(ctx.music!.actor);
    expect(result.content).toBe("Playback paused.");
  });

  it("refuses when the caller can't control music", async () => {
    const pause = vi.fn();
    const command = new PauseCommand({ pause } as unknown as PlaybackService, fakeProfiles());
    const result = await command.toolBinding.execute({}, contextWithoutMusic());
    expect(result.content).toMatch(/music-controller role/);
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("VolumeCommand.toolBinding", () => {
  it("clamps the requested volume to the guild's configured maximum", async () => {
    const setVolume = vi.fn(() => Promise.resolve());
    const command = new VolumeCommand({ setVolume } as unknown as PlaybackService, fakeProfiles({ maximumVolume: 100 }));
    const ctx = contextWithMusic();
    const result = await command.toolBinding.execute({ volume: 250 }, ctx);
    expect(setVolume).toHaveBeenCalledWith(ctx.music!.actor, 100, 100);
    expect(result.content).toBe("Volume set to 100.");
  });
});
