import type { Pacing } from "../../../domain/campaign/state/campaign-state.js";
import type { PacingPresetId } from "../ports/campaign-record.js";

// Plan §5, Pacing presets. Instant (every action resolves at once) needs
// per-action resolution the engine does not have yet, so it is not offered.
export const pacingPresets: Readonly<Record<Exclude<PacingPresetId, "custom">, Pacing>> = {
  live: { roundSeconds: 5 * 60, rollSeconds: 2 * 60, turnSeconds: 3 * 60, awayAfterMisses: 2 },
  playByPost: { roundSeconds: 24 * 3600, rollSeconds: 12 * 3600, turnSeconds: 12 * 3600, awayAfterMisses: 2 },
};

const limits = { minSeconds: 30, maxSeconds: 7 * 24 * 3600, maxMisses: 10 } as const;

export type PacingChoice = { readonly preset: "live" | "playByPost" } | { readonly preset: "custom"; readonly pacing: Pacing };

// The pacing a choice means, or why it is not acceptable. A timer may be null
// (no timer); otherwise it must be a whole number of seconds in range.
export function resolvePacing(choice: PacingChoice): { readonly ok: true; readonly pacing: Pacing } | { readonly ok: false; readonly problem: string } {
  if (choice.preset !== "custom") return { ok: true, pacing: pacingPresets[choice.preset] };
  const { roundSeconds, rollSeconds, turnSeconds, awayAfterMisses } = choice.pacing;
  for (const [name, seconds] of [["round", roundSeconds], ["roll", rollSeconds], ["turn", turnSeconds]] as const) {
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < limits.minSeconds || seconds > limits.maxSeconds)) {
      return { ok: false, problem: `The ${name} timer must be between ${limits.minSeconds} seconds and 7 days, or off.` };
    }
  }
  if (!Number.isInteger(awayAfterMisses) || awayAfterMisses < 1 || awayAfterMisses > limits.maxMisses) {
    return { ok: false, problem: `Away after misses must be between 1 and ${limits.maxMisses}.` };
  }
  return { ok: true, pacing: choice.pacing };
}
