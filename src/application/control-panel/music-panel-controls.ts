import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { MusicPlayerNotFoundError } from "../music/music-errors.js";
import type { MusicPlayerGateway, MusicPlayerSnapshot } from "../music/music-player-gateway.js";
import type { PlaybackActor, PlaybackService } from "../music/playback-service.js";

export const musicPanelControlIdPrefix = "music-panel:v1:";

type MusicPanelControlRow = "primary" | "secondary";

interface MusicPanelRenderContext {
  profile: GuildConfiguration;
  snapshot: MusicPlayerSnapshot | null;
  hasActiveTrack: boolean;
}

export interface MusicPanelExecutionContext {
  actor: PlaybackActor;
  profile: GuildConfiguration;
  playbackService: PlaybackService;
  playerGateway: MusicPlayerGateway;
}

export interface MusicPanelControl {
  id: string;
  row: MusicPanelControlRow;
  render(context: MusicPanelRenderContext): ButtonBuilder;
  execute(context: MusicPanelExecutionContext): Promise<void>;
  // For toggle-style controls only: the boolean snapshot field this button
  // flips. Lets the panel show an instant, optimistic flip to the new
  // color/state (and disable the button) the moment it's clicked, rather than
  // waiting on the Lavalink round trip before anything visibly changes. The
  // follow-up refresh (always run after execute) reconciles with ground
  // truth, so a failed toggle self-corrects on the very next render.
  toggledSnapshotField?: "autoQueue" | "twentyFourSeven";
}

function controlButton(id: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(`${musicPanelControlIdPrefix}${id}`);
}

const musicPanelControls: readonly MusicPanelControl[] = [
  {
    id: "previous",
    row: "primary",
    render: ({ snapshot, hasActiveTrack }) => controlButton("previous")
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasActiveTrack || (snapshot?.previousTrackCount ?? 0) === 0),
    execute: async ({ playbackService, actor }) => playbackService.previous(actor),
  },
  {
    id: "play-pause",
    row: "primary",
    render: ({ snapshot, hasActiveTrack }) => controlButton("play-pause")
      .setEmoji(snapshot?.paused ? "▶️" : "⏯️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasActiveTrack),
    execute: async ({ playbackService, playerGateway, actor }): Promise<void> => {
      if (!playerGateway.hasPlayer(actor.guildId)) throw new MusicPlayerNotFoundError();
      if (playerGateway.isPaused(actor.guildId)) await playbackService.resume(actor);
      else await playbackService.pause(actor);
    },
  },
  {
    id: "stop",
    row: "primary",
    render: ({ hasActiveTrack }) => controlButton("stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasActiveTrack),
    execute: async ({ playbackService, actor }) => playbackService.stop(actor),
  },
  {
    id: "skip",
    row: "primary",
    render: ({ hasActiveTrack }) => controlButton("skip")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasActiveTrack),
    execute: async ({ playbackService, actor }) => playbackService.skip(actor),
  },
  {
    id: "volume-down",
    row: "secondary",
    render: ({ snapshot, hasActiveTrack }) => controlButton("volume-down")
      .setEmoji("🔉")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasActiveTrack || (snapshot?.volume ?? 0) <= 0),
    execute: async ({ playbackService, actor, profile }) => playbackService.changeVolume(
      actor,
      -profile.music.volumeButtonStep,
      profile.music.maximumVolume,
    ),
  },
  {
    id: "volume-up",
    row: "secondary",
    render: ({ snapshot, profile, hasActiveTrack }) => controlButton("volume-up")
      .setEmoji("🔊")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(
        !hasActiveTrack ||
        (snapshot?.volume ?? profile.music.maximumVolume) >= profile.music.maximumVolume,
      ),
    execute: async ({ playbackService, actor, profile }) => playbackService.changeVolume(
      actor,
      profile.music.volumeButtonStep,
      profile.music.maximumVolume,
    ),
  },
  {
    id: "autoqueue",
    row: "secondary",
    render: ({ snapshot, hasActiveTrack }) => controlButton("autoqueue")
      .setLabel("Autoqueue")
      .setEmoji("♾️")
      .setStyle(snapshot?.autoQueue ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!hasActiveTrack),
    execute: async ({ playbackService, actor }): Promise<void> => {
      await playbackService.toggleAutoQueue(actor);
    },
    toggledSnapshotField: "autoQueue",
  },
  {
    id: "24-7",
    row: "secondary",
    render: ({ snapshot }) => controlButton("24-7")
      .setLabel("24/7")
      .setEmoji("🔁")
      .setStyle(snapshot?.twentyFourSeven ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!snapshot),
    execute: async ({ playbackService, actor }): Promise<void> => {
      await playbackService.toggleTwentyFourSeven(actor);
    },
    toggledSnapshotField: "twentyFourSeven",
  },
  {
    id: "shuffle",
    row: "secondary",
    render: ({ snapshot, hasActiveTrack }) => controlButton("shuffle")
      .setEmoji("🔀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasActiveTrack || (snapshot?.queueLength ?? 0) < 2),
    execute: async ({ playbackService, actor }) => playbackService.shuffle(actor),
  },
];

const controlsById = new Map(musicPanelControls.map((control) => [control.id, control]));

export function findMusicPanelControl(customId: string): MusicPanelControl | null {
  if (!customId.startsWith(musicPanelControlIdPrefix)) return null;
  return controlsById.get(customId.slice(musicPanelControlIdPrefix.length)) ?? null;
}

export function createMusicPanelControlRows(
  profile: GuildConfiguration,
  snapshot: MusicPlayerSnapshot | null,
  pendingControlId?: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const context: MusicPanelRenderContext = {
    profile,
    snapshot,
    hasActiveTrack: Boolean(snapshot?.currentTrack),
  };
  const createRow = (row: MusicPanelControlRow): ActionRowBuilder<ButtonBuilder> =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      musicPanelControls
        .filter((control) => control.row === row)
        .map((control) => {
          const button = control.render(context);
          if (control.id === pendingControlId) button.setDisabled(true);
          return button;
        }),
    );

  return [createRow("primary"), createRow("secondary")];
}
