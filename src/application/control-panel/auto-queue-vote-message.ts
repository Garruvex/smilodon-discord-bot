import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { AutoQueueVoteSnapshot, MusicPlayerSnapshot } from "../music/music-player-gateway.js";
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
  | { kind: "reroll" };

export type ReadyAutoQueueVote = Extract<AutoQueueVoteSnapshot, { status: "ready" }>;

export function parseAutoQueueVoteCustomId(customId: string): AutoQueueVoteAction | null {
  if (!customId.startsWith(autoQueueVoteIdPrefix)) return null;
  const action = customId.slice(autoQueueVoteIdPrefix.length);
  if (action === "reroll") return { kind: "reroll" };
  const match = /^option-(\d)$/.exec(action);
  return match ? { kind: "option", index: Number(match[1]) } : null;
}

// When the vote closes, as a Discord timestamp that counts down on its own,
// so the message doesn't need editing every second to stay accurate. Null
// while there's no meaningful end: paused, or a stream with no duration.
export function autoQueueVoteClosesAtSeconds(snapshot: MusicPlayerSnapshot, nowMs: number): number | null {
  const track = snapshot.currentTrack;
  if (!track || snapshot.paused || track.isStream || track.durationMs <= 0) return null;
  return Math.round((nowMs + Math.max(0, track.durationMs - track.positionMs)) / 1000);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function createAutoQueueVotePayload(
  profile: GuildConfiguration,
  vote: ReadyAutoQueueVote,
  closesAtSeconds: number | null,
): { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const totalVotes = vote.options.reduce((sum, option) => sum + option.votes, 0);
  const lines = vote.options.map((option, index) => {
    const leading = index === vote.leadingIndex;
    const title = truncate(option.title, 80);
    const linked = option.uri ? `[${title}](${option.uri})` : title;
    const lyrics = option.lyricsAvailable === true ? " 🎤" : "";
    const count = `${leading ? `**${option.votes}**` : option.votes} vote${option.votes === 1 ? "" : "s"}`;
    const author = truncate(option.author, 60);
    // The leader is set apart three ways (marker, bold, highlighted bar) so it
    // reads at a glance, even to someone skimming on a phone.
    const heading = leading
      ? `▶ **${optionEmojis[index]} ${linked}** — ${author}${lyrics} · up next`
      : `${optionEmojis[index]} ${linked} — ${author}${lyrics}`;
    return `${heading}\n${renderVoteBar(option.votes, totalVotes, leading, profile.music.autoQueueVoteBarStyle)}  ${count}`;
  });
  const closes = closesAtSeconds === null
    ? "Voting closes when this track ends."
    : `Voting closes <t:${closesAtSeconds}:R>.`;
  const embed = new EmbedBuilder()
    .setColor(profile.embedColor as `#${string}`)
    .setTitle("🗳️ Vote: what plays next")
    .setDescription(
      `${lines.join("\n\n")}\n\n${closes} No votes means option 1 plays.\n` +
      "-# 🎤 has synced lyrics. Only listeners in the voice channel can vote. Click your pick again to take your vote back.",
    );

  const buttons = [
    ...vote.options.map((option, index) => new ButtonBuilder()
      .setCustomId(`${autoQueueVoteIdPrefix}option-${index}`)
      .setEmoji(optionEmojis[index]!)
      .setLabel(String(option.votes))
      .setStyle(index === vote.leadingIndex ? ButtonStyle.Success : ButtonStyle.Secondary)),
    new ButtonBuilder()
      .setCustomId(`${autoQueueVoteIdPrefix}reroll`)
      .setEmoji("🎲")
      .setLabel("Reroll")
      .setStyle(ButtonStyle.Secondary),
  ];
  // Discord allows at most 5 buttons per row, so 5 or 6 options wrap onto a
  // second row, with reroll always last.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let start = 0; start < buttons.length; start += maxButtonsPerRow) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(start, start + maxButtonsPerRow)));
  }

  return { content: "", embeds: [embed], components: rows };
}
