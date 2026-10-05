import type { HitDiceCommand } from "../commands/campaign-command.js";
import { abilityModifier } from "../character/character-sheet.js";
import { hitDicePool } from "../character/character-build.js";
import { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { combine, dice, flat, isDieSize } from "../dice/dice-expression.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../dice/roll-spec.js";
import { isFallen, type PendingHitDice } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Hit Dice on a short rest (SRD 5.1): after the party's short rest, each hero may spend as many of their remaining Hit Dice as they like. Every die is
// rolled, the Constitution modifier is added to each, and the total is the hit points regained. The dice are taken largest first, as a rest always did.
export function handleHitDiceCommand(decision: Decision, command: HitDiceCommand): Rejection | null {
  const { state, ctx } = decision;
  const sheet = state.characters[command.characterId];
  if (ctx.actor.kind !== "user" || sheet === undefined || sheet.ownerUserId !== ctx.actor.userId) return { code: "notYourCharacter" };
  if (isFallen(state, sheet.id)) return { code: "heroFallen" };
  if (state.shortRestOpen !== true || state.round !== null || (state.encounter !== null && state.encounter.status !== "ended")) return { code: "noShortRest" };
  if (state.hitDicePending?.[sheet.id] !== undefined) return { code: "hitDicePending" };
  const status = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: defaultHeroResources(sheet, ctx.rules.content) };
  const left = status.hitDice ?? sheet.level;
  if (!Number.isInteger(command.count) || command.count < 1) return { code: "invalidTarget" };
  if (left < 1 || command.count > left) return { code: "noHitDice" };
  if (status.hp >= sheet.maxHp) return { code: "nothingToHeal" };
  const pool = hitDicePool(sheet);
  const taken = pool.slice(pool.length - left, pool.length - left + command.count);
  const sides = taken.filter(isDieSize);
  const expression = combine(...sides.map((die) => dice(1, die)), flat(abilityModifier(sheet.abilityScores.con) * command.count));
  const pending: PendingHitDice = { characterId: sheet.id, count: command.count, expression, rollId: `hit-dice-roll:${sheet.id}:${(state.hitDiceCount ?? 0) + 1}` };
  const spec: RollSpec = { kind: "dice", expression, critical: false };
  decision.emit({ kind: "hitDiceStarted", pending });
  decision.request({ kind: "roll", rollId: pending.rollId, spec });
  return null;
}

// The dice were rolled: the hit points come back (never above the maximum, and never below what the hero had), and the Hit Dice are spent.
export function recordHitDiceRoll(decision: Decision, pending: PendingHitDice, result: RollResult): Rejection | null {
  if (!resultMatchesSpec(result, { kind: "dice", expression: pending.expression, critical: false }) || result.kind !== "dice") return { code: "rollMismatch" };
  const { state, ctx } = decision;
  const sheet = state.characters[pending.characterId];
  if (sheet === undefined) return { code: "staleNarration" };
  const before: HeroStatus = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: defaultHeroResources(sheet, ctx.rules.content) };
  // Song of Rest: a bard in the party adds one more Hit Die of healing (its average) to everyone who spends Hit Dice on the rest.
  const song = Math.max(0, ...Object.values(state.characters).map((member) => (member.features.includes("feature:song-of-rest") && !isFallen(state, member.id) ? Math.floor((member.level >= 17 ? 12 : member.level >= 13 ? 10 : member.level >= 9 ? 8 : 6) / 2) + 1 : 0)));
  const rolled = Math.max(0, result.roll.total) + song;
  const hp = Math.min(sheet.maxHp, before.hp + rolled);
  const heroStatus: HeroStatus = { ...before, hp, hitDice: Math.max(0, (before.hitDice ?? sheet.level) - pending.count) };
  decision.emit({ kind: "hitDiceSettled", characterId: sheet.id as CharacterId, count: pending.count, rolled, healed: hp - before.hp, heroStatus });
  decision.request({ kind: "deliver", delivery: { kind: "hitDiceSettled", characterId: sheet.id, count: pending.count, rolled, healed: hp - before.hp, hpAfter: hp } });
  return null;
}
