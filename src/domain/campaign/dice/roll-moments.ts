import { assertNever } from "../core/assert-never.js";
import { bonusTotal, resolveD20Test, type D20TestKind, type D20TestRoll, type NaturalRollRule } from "./d20-test.js";

// Highlights of a saved d20 test (panel spec: Dice moments). Classified once
// when the roll is resolved and stored with it, so result lines, narration,
// and the session recap agree. Combat moments (killing blow, reaction
// flipped the outcome) join this union with the combat engine.
export type RollMoment =
  | { readonly kind: "criticalHit" }
  | { readonly kind: "automaticMiss" }
  | { readonly kind: "deathSaveRevival" }
  | { readonly kind: "deathSaveDoubleFailure" }
  // Checks and saves: the flourish only. Whether the natural roll decided
  // the outcome depends on the natural-roll house rule.
  | { readonly kind: "natural20" }
  | { readonly kind: "natural1" }
  | { readonly kind: "exactlyEnough" }
  | { readonly kind: "bonusDieFlipped"; readonly sources: readonly string[] }
  | { readonly kind: "advantageSaved" }
  | { readonly kind: "missedByOne" }
  | { readonly kind: "disadvantageCost" };

export type MomentTier = "legendary" | "disaster" | "clutch" | "heartbreak";

export interface RollMoments {
  // The one moment presented as the headline: the highest tier present.
  readonly headline: RollMoment | null;
  readonly tags: readonly RollMoment[];
}

export interface MomentInput {
  readonly kind: D20TestKind;
  readonly roll: D20TestRoll;
  readonly target: number;
  readonly naturalRule: NaturalRollRule;
}

const tierRank: Record<MomentTier, number> = { legendary: 4, disaster: 3, clutch: 2, heartbreak: 1 };

export function momentTier(moment: RollMoment): MomentTier {
  switch (moment.kind) {
    case "criticalHit":
    case "deathSaveRevival":
    case "natural20":
      return "legendary";
    case "automaticMiss":
    case "deathSaveDoubleFailure":
    case "natural1":
      return "disaster";
    case "exactlyEnough":
    case "bonusDieFlipped":
    case "advantageSaved":
      return "clutch";
    case "missedByOne":
    case "disadvantageCost":
      return "heartbreak";
    default:
      return assertNever(moment);
  }
}

export function classifyRollMoments(input: MomentInput): RollMoments {
  const { kind, roll, target, naturalRule } = input;
  const natural = roll.d20.natural;
  const outcome = resolveD20Test(kind, natural, roll.total, target, naturalRule);
  const moments: RollMoment[] = [];

  const naturalMoment = naturalMomentOf(kind, natural);
  if (naturalMoment !== null) moments.push(naturalMoment);

  if (outcome.decidedByNatural === null) {
    if (outcome.success && roll.total === target) moments.push({ kind: "exactlyEnough" });
    if (!outcome.success && roll.total === target - 1) moments.push({ kind: "missedByOne" });
    const bonus = bonusTotal(roll.bonusDice);
    if (outcome.success && bonus > 0 && !resolveD20Test(kind, natural, roll.total - bonus, target, naturalRule).success) {
      moments.push({ kind: "bonusDieFlipped", sources: roll.bonusDice.map((die) => die.source) });
    }
  }

  // With advantage or disadvantage, would the other die have changed the outcome?
  const other = otherDie(roll);
  if (other !== null) {
    const otherOutcome = resolveD20Test(kind, other, roll.total - natural + other, target, naturalRule);
    if (roll.d20.mode === "advantage" && outcome.success && !otherOutcome.success) {
      moments.push({ kind: "advantageSaved" });
    }
    if (roll.d20.mode === "disadvantage" && !outcome.success && otherOutcome.success) {
      moments.push({ kind: "disadvantageCost" });
    }
  }

  // Stable sort keeps discovery order within a tier.
  const ranked = [...moments].sort((a, b) => tierRank[momentTier(b)] - tierRank[momentTier(a)]);
  const [headline = null, ...tags] = ranked;
  return { headline, tags };
}

function naturalMomentOf(kind: D20TestKind, natural: number): RollMoment | null {
  if (natural !== 20 && natural !== 1) return null;
  switch (kind) {
    case "attack":
      return natural === 20 ? { kind: "criticalHit" } : { kind: "automaticMiss" };
    case "deathSave":
      return natural === 20 ? { kind: "deathSaveRevival" } : { kind: "deathSaveDoubleFailure" };
    case "abilityCheck":
    case "savingThrow":
      return natural === 20 ? { kind: "natural20" } : { kind: "natural1" };
    default:
      return assertNever(kind);
  }
}

function otherDie(roll: D20TestRoll): number | null {
  const [first, second] = roll.d20.values;
  if (roll.d20.mode === "normal" || first === undefined || second === undefined) return null;
  return roll.d20.mode === "advantage" ? Math.min(first, second) : Math.max(first, second);
}
