import type { BoostEvent } from "./boost-history-store.js";

// Sums completed start/end pairs from the logged history, then adds the
// current ongoing streak (if any) straight from live premiumSince rather
// than the log — premiumSince is the ground truth for "boosting right now",
// and covers the case where a member was already boosting before this
// feature started logging transitions (no matching "started" event exists).
export function computeTotalBoostedMs(
  pastEvents: readonly BoostEvent[],
  currentlyBoostingSince: Date | null,
  now: Date,
): number {
  let total = 0;
  let openStart: Date | null = null;
  for (const event of pastEvents) {
    if (event.eventType === "started") {
      openStart = event.occurredAt;
    } else if (openStart) {
      total += Math.max(0, event.occurredAt.getTime() - openStart.getTime());
      openStart = null;
    }
  }
  if (currentlyBoostingSince) {
    total += Math.max(0, now.getTime() - currentlyBoostingSince.getTime());
  }
  return total;
}

export function formatDurationMs(durationMs: number): string {
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes < 60) return "less than an hour";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "less than an hour";
}
