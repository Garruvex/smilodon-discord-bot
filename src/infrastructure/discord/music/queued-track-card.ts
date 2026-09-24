import { EmbedBuilder } from "discord.js";

import { texts, type Texts } from "../../../application/i18n/texts.js";
import type { EnqueueResult } from "../../../domain/music/music-track.js";

export const queuedTrackCardLifetimeMs = 30_000;
export const failedMusicRequestLifetimeMs = 15_000;

export function createQueuedTrackCard(
  result: EnqueueResult,
  embedColor?: `#${string}`,
  text: Texts = texts.en,
): EmbedBuilder {
  const card = text.music.card;
  const track = result.firstTrack;
  const title = track.uri ? `[${track.title}](${track.uri})` : track.title;
  const embed = new EmbedBuilder()
    .setTitle(
      result.addedTrackCount > 1
        ? card.playlistAdded
        : result.startedPlayback
          ? card.nowPlaying
          : card.addedToQueue,
    )
    .setDescription(title)
    .addFields(
      { name: card.artist, value: track.author || card.unknownArtist, inline: true },
      {
        name: card.duration,
        value: track.isStream ? "`LIVE 🔴`" : `\`${formatDuration(track.durationMs)}\``,
        inline: true,
      },
      { name: card.requestedBy, value: `<@${track.requestedByUserId}>`, inline: true },
    );

  if (result.addedTrackCount > 1) {
    embed.addFields({
      name: card.tracksAdded,
      value: String(result.addedTrackCount),
      inline: true,
    });
  }
  if (result.queuePosition !== null) {
    embed.addFields({
      name: card.positionInQueue,
      value: String(result.queuePosition),
      inline: true,
    });
  }
  if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
  if (embedColor) embed.setColor(embedColor);
  return embed;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
