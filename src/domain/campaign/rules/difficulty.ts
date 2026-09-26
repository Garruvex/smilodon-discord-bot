// Improvised ability-check DCs come only from this ladder (plan §6, Checks
// and difficulty). All other DCs come from formulas or validated content.
export const dcLadder = {
  "very-easy": 5,
  easy: 10,
  medium: 15,
  hard: 20,
  "very-hard": 25,
  "nearly-impossible": 30,
} as const;

export type DcTier = keyof typeof dcLadder;

export function isDcTier(value: string): value is DcTier {
  return Object.hasOwn(dcLadder, value);
}

// Why the Planner grants advantage or disadvantage on an improvised check.
// Each reason has a fixed direction, so a proposal cannot pair "help" with
// disadvantage.
export const rollModeReasons = {
  help: "advantage",
  "favorable-circumstance": "advantage",
  "unfavorable-circumstance": "disadvantage",
} as const;

export type RollModeReason = keyof typeof rollModeReasons;

export function isRollModeReason(value: string): value is RollModeReason {
  return Object.hasOwn(rollModeReasons, value);
}
