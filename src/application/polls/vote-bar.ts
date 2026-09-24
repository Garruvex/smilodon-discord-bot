import type { AutoQueueVoteBarStyle } from "../../config/guild-configuration.js";

const barLengths: Record<AutoQueueVoteBarStyle, number> = {
  // Emoji squares are wide, so fewer of them fit on a phone line.
  squares: 8,
  thin: 12,
};

// A vote share drawn as a bar. "squares" uses emoji squares, which keep
// their color on every Discord client (unlike ANSI code blocks, which mobile
// renders plain), with the leading choice in green and the rest in blue.
// "thin" matches the panel's progress bar and marks the leader in bold.
export function renderVoteBar(
  votes: number,
  totalVotes: number,
  highlighted: boolean,
  style: AutoQueueVoteBarStyle = "squares",
): string {
  const length = barLengths[style];
  const share = totalVotes > 0 ? votes / totalVotes : 0;
  // Any vote at all gets at least one segment, so "1 of 40" doesn't read as
  // no votes.
  const filled = votes > 0 ? Math.min(length, Math.max(1, Math.round(share * length))) : 0;
  if (style === "thin") {
    const bar = `${"▰".repeat(filled)}${"▱".repeat(length - filled)}`;
    return highlighted ? `**${bar}**` : bar;
  }
  return `${(highlighted ? "🟩" : "🟦").repeat(filled)}${"⬛".repeat(length - filled)}`;
}
