import { describe, expect, it, vi } from "vitest";

import {
  findMusicPanelControl,
  musicPanelControlIdPrefix,
} from "../../src/application/control-panel/music-panel-controls.js";
import type { MusicPlayerGateway } from "../../src/application/music/music-player-gateway.js";
import type { PlaybackActor, PlaybackService } from "../../src/application/music/playback-service.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

const actor = {
  guildId: "123456789012345678",
  textChannelId: "234567890123456789",
  userId: "345678901234567890",
  member: {},
} as PlaybackActor;

const profile = {
  music: {
    volumeButtonStep: 10,
    maximumVolume: 150,
  },
} as GuildConfiguration;

describe("music panel controls", () => {
  it("resolves only registered panel controls", () => {
    expect(findMusicPanelControl(`${musicPanelControlIdPrefix}skip`)?.id).toBe("skip");
    expect(findMusicPanelControl(`${musicPanelControlIdPrefix}removed-control`)).toBeNull();
    expect(findMusicPanelControl("another-component:skip")).toBeNull();
  });

  it("executes volume controls with guild configuration values", async () => {
    const changeVolume = vi.fn().mockResolvedValue(undefined);
    const control = findMusicPanelControl(`${musicPanelControlIdPrefix}volume-down`);

    await control?.execute({
      actor,
      profile,
      playbackService: { changeVolume } as unknown as PlaybackService,
      playerGateway: {} as MusicPlayerGateway,
    });

    expect(changeVolume).toHaveBeenCalledWith(actor, -10, 150);
  });

  it("uses the current player state for the play-pause callback", async () => {
    const pause = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockResolvedValue(undefined);
    const control = findMusicPanelControl(`${musicPanelControlIdPrefix}play-pause`);

    await control?.execute({
      actor,
      profile,
      playbackService: { pause, resume } as unknown as PlaybackService,
      playerGateway: {
        hasPlayer: () => true,
        isPaused: () => true,
      } as unknown as MusicPlayerGateway,
    });

    expect(resume).toHaveBeenCalledWith(actor);
    expect(pause).not.toHaveBeenCalled();
  });
});
