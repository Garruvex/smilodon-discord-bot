import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

import { texts, type Texts } from "../../../application/i18n/texts.js";
import {
  formatQueueDuration,
  formatQueueTrackLine,
  sumTrackDurations,
} from "../../../application/music/queue-formatting.js";
import type { MusicTrack } from "../../../domain/music/music-track.js";

export const queuePageComponentIdPrefix = "queue-page";
export const queuePageSize = 10;

export interface QueuePageView {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
}

export function buildQueuePageView(
  tracks: readonly MusicTrack[],
  page: number,
  embedColor: `#${string}`,
  text: Texts = texts.en,
): QueuePageView {
  const queue = text.music.queue;
  const pageCount = Math.max(1, Math.ceil(tracks.length / queuePageSize));
  const clampedPage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = clampedPage * queuePageSize;
  const pageTracks = tracks.slice(start, start + queuePageSize);

  const embed = new EmbedBuilder().setColor(embedColor).setTitle(queue.title);
  embed.setDescription(
    tracks.length === 0
      ? queue.empty
      : pageTracks
        .map((track, index) => formatQueueTrackLine(track, start + index + 1, text.music.label.autoqueue))
        .join("\n"),
  );
  if (tracks.length > 0) {
    embed.setFooter({
      text: queue.footer({
        page: clampedPage + 1,
        pages: pageCount,
        count: tracks.length,
        duration: formatQueueDuration(sumTrackDurations(tracks)),
      }),
    });
  }

  // Only worth showing nav buttons when there's a second page to go to —
  // a single-page queue has nothing to paginate.
  const components = pageCount > 1
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${queuePageComponentIdPrefix}:${clampedPage - 1}`)
            .setLabel(queue.previousPage)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(clampedPage <= 0),
          new ButtonBuilder()
            .setCustomId(`${queuePageComponentIdPrefix}:${clampedPage + 1}`)
            .setLabel(queue.nextPage)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(clampedPage >= pageCount - 1),
        ),
      ]
    : [];

  return { embed, components };
}
