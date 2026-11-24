// Summarizes the prior-answer anchor's context.guard.coverage events from the bot's JSON log lines:
// how often a follow-up's likely referent was still in the window, beyond it, or not found, and how
// often the anchor added messages. Reads only structural fields; log lines carry no message text.
export interface AnchorLogSummary {
  turns: number; observed: number; none: number; window: number; beyond: number; anchored: number;
  beyondRate: number | null; byGuild: Record<string, { observed: number; beyond: number; anchored: number }>;
  firstAt: number | null; lastAt: number | null;
}

export function summarizeAnchorLog(lines: Iterable<string>): AnchorLogSummary {
  const summary: AnchorLogSummary = { turns: 0, observed: 0, none: 0, window: 0, beyond: 0, anchored: 0, beyondRate: null, byGuild: {}, firstAt: null, lastAt: null };
  for (const line of lines) {
    if (!line.includes("context.guard.coverage")) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.event !== "context.guard.coverage" || typeof entry.requested !== "number" || entry.requested <= 0) continue;
    summary.turns++;
    const match = entry.anchorMatch;
    if (match !== "none" && match !== "window" && match !== "beyond") continue;
    summary.observed++; summary[match]++;
    const anchored = typeof entry.anchor === "number" && entry.anchor > 0; if (anchored) summary.anchored++;
    const guild = typeof entry.guildId === "string" ? entry.guildId : "unknown";
    const row = summary.byGuild[guild] ??= { observed: 0, beyond: 0, anchored: 0 };
    row.observed++; if (match === "beyond") row.beyond++; if (anchored) row.anchored++;
    if (typeof entry.time === "number") {
      summary.firstAt = Math.min(summary.firstAt ?? entry.time, entry.time); summary.lastAt = Math.max(summary.lastAt ?? entry.time, entry.time);
    }
  }
  summary.beyondRate = summary.observed ? summary.beyond / summary.observed : null;
  return summary;
}
