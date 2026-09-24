import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { cleanArtistName } from "../../domain/music/artist-name.js";
import { texts, type Texts } from "../i18n/texts.js";
import type { AutoQueueVoteRerollMode, AutoQueueVoteSnapshot } from "../music/music-player-gateway.js";
import { renderVoteBar } from "../polls/vote-bar.js";

// Separate from the panel's own prefix on purpose: these buttons live on
// their own short-lived message, not the queue message the panel controls
// are validated against.
export const autoQueueVoteIdPrefix = "music-vote:v1:";

// Enough for the largest vote the setting allows (see MUSIC_LIMITS).
const optionEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
const maxButtonsPerRow = 5;

export type AutoQueueVoteAction =
  | { kind: "option"; index: number }
  | { kind: "reroll"; mode: AutoQueueVoteRerollMode };

export type ReadyAutoQueueVote = Extract<AutoQueueVoteSnapshot, { status: "ready" }>;

export interface AutoQueueVoteRenderContext {
  // Whole seconds since the epoch at which voting locks, or null when
  // there's no countdown to show (paused, or a stream).
  closesAtSeconds: number | null;
  paused: boolean;
  // Artist of the track that's playing, for the "More from" reroll.
  currentArtist: string;
}

export function parseAutoQueueVoteCustomId(customId: string): AutoQueueVoteAction | null {
  if (!customId.startsWith(autoQueueVoteIdPrefix)) return null;
  const action = customId.slice(autoQueueVoteIdPrefix.length);
  if (action === "reroll") return { kind: "reroll", mode: "similar" };
  if (action === "reroll-artist") return { kind: "reroll", mode: "artist" };
  const match = /^option-(\d)$/.exec(action);
  return match ? { kind: "option", index: Number(match[1]) } : null;
}

// When voting locks, as a Discord timestamp that counts down on its own, so
// the message doesn't need editing every second to stay accurate.
export function autoQueueVoteClosesAtSeconds(
  vote: ReadyAutoQueueVote,
  paused: boolean,
  nowMs: number,
): number | null {
  if (paused || vote.locked || vote.closesInMs === null) return null;
  return Math.round((nowMs + vote.closesInMs) / 1000);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// Kept to one short line on purpose: the marker, bold and bar colour
// already say what's up next, so this only carries timing and rerolls.
function footerLine(vote: ReadyAutoQueueVote, context: AutoQueueVoteRenderContext, text: Texts["music"]["vote"]): string {
  const timing = context.paused
    ? text.paused
    : context.closesAtSeconds === null
      ? text.openUntilSkip
      : text.closes({ time: `<t:${context.closesAtSeconds}:R>` });
  // Rerolling clears everyone's votes, so say who did it; otherwise it
  // just looks like the votes vanished.
  const rerolls = vote.lastRerolledByUserId
    ? text.rerolledBy({ user: `<@${vote.lastRerolledByUserId}>`, count: vote.rerollsLeft })
    : text.rerollsLeft({ count: vote.rerollsLeft });
  return `-# ${timing} · ${rerolls}`;
}

export function createAutoQueueVotePayload(
  profile: GuildConfiguration,
  vote: ReadyAutoQueueVote,
  context: AutoQueueVoteRenderContext,
): { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const text = texts[profile.language].music.vote;
  const totalVotes = vote.options.reduce((sum, option) => sum + option.votes, 0);
  const lines = vote.options.map((option, index) => {
    const leading = index === vote.leadingIndex;
    const title = truncate(option.title, 80);
    const linked = option.uri ? `[${title}](${option.uri})` : title;
    const lyrics = option.lyricsAvailable === true ? " 🎤" : "";
    const count = leading ? `**${option.votes}**` : String(option.votes);
    const author = truncate(cleanArtistName(option.author), 60);
    // The leader is set apart three ways (marker, bold, highlighted bar) so it
    // reads at a glance, even to someone skimming on a phone.
    const heading = leading
      ? `▶ **${optionEmojis[index]} ${linked}** — ${author}${lyrics}`
      : `${optionEmojis[index]} ${linked} — ${author}${lyrics}`;
    return `${heading}\n${renderVoteBar(option.votes, totalVotes, leading, profile.music.autoQueueVoteBarStyle)} ${count}`;
  });
  // Once locked, the 🔒 title says it all; the footer's countdown and
  // reroll count no longer apply.
  const embed = new EmbedBuilder()
    .setColor(profile.embedColor as `#${string}`)
    .setTitle(vote.locked ? text.titleLocked : text.title)
    .setDescription(vote.locked ? lines.join("\n") : `${lines.join("\n")}\n${footerLine(vote, context, text)}`);

  const optionButtons = vote.options.map((option, index) => new ButtonBuilder()
    .setCustomId(`${autoQueueVoteIdPrefix}option-${index}`)
    .setEmoji(optionEmojis[index]!)
    .setLabel(String(option.votes))
    .setStyle(index === vote.leadingIndex ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(vote.locked));
  // Discord allows at most 5 buttons per row, so 6 options wrap onto a
  // second row. Rerolls always get a row of their own below the options,
  // so the layout stays the same whatever the option count.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let start = 0; start < optionButtons.length; start += maxButtonsPerRow) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(optionButtons.slice(start, start + maxButtonsPerRow)));
  }
  const rerollDisabled = vote.locked || vote.rerollsLeft === 0;
  const artist = context.currentArtist.trim();
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${autoQueueVoteIdPrefix}reroll`)
      .setEmoji("🎲")
      .setLabel(text.similar)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(rerollDisabled),
    new ButtonBuilder()
      .setCustomId(`${autoQueueVoteIdPrefix}reroll-artist`)
      .setEmoji("🎙️")
      .setLabel(artist ? truncate(artist, 60) : text.sameArtist)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(rerollDisabled),
  ));

  return { content: "", embeds: [embed], components: rows };
}
