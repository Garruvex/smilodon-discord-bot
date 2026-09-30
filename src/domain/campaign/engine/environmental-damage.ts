import type { EnvironmentalDamageSource } from "../commands/campaign-command.js";
import { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { dice, type DiceExpression } from "../dice/dice-expression.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../dice/roll-spec.js";
import { traitsOf } from "../rules/content-definitions.js";
import type { DamageType } from "../rules/effects.js";
import { damageMultiplier, type Trait } from "../rules/traits.js";
import { isFallen, type EnvironmentalCause, type EnvironmentalDamageRecord, type PendingEnvironmentalDamage } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Damage between fights: a fall, drowning, a trap, a scorching desert. The organizer names the source and the dice decide how
// much it hurts (never the Narrator). A hero taken to 0 hit points lies unconscious and stable until healed or rested, and one
// whose damage passes their hit point maximum dies, as in a fight.
const maxFallDice = 20;

export function takeEnvironmentalDamage(decision: Decision, characterId: CharacterId, source: EnvironmentalDamageSource): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (isFallen(state, characterId)) return { code: "heroFallen" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (state.damagePending?.[characterId] !== undefined) return { code: "hazardAlreadyPending" };
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "notYourCharacter" };

  const count = source.kind === "fall" ? Math.min(maxFallDice, Math.floor(source.feet / 10)) : source.kind === "damage" ? source.count : 0;
  if (source.kind === "suffocation") return settle(decision, characterId, "suffocation", null, null, 0);
  if (!Number.isInteger(count) || count < 1) return { code: "invalidHazardDamage" };
  const cause: EnvironmentalCause = source.kind === "fall" ? "fall" : "other";
  const expression = dice(count, source.kind === "fall" ? 6 : source.sides);
  const damageType: DamageType = source.kind === "fall" ? "bludgeoning" : source.damageType;
  const pending: PendingEnvironmentalDamage = { characterId, cause, expression, damageType, rollId: `env-damage-roll:${characterId}:${(state.damageCount ?? 0) + 1}` };
  decision.emit({ kind: "environmentalDamageStarted", pending });
  decision.request({ kind: "roll", rollId: pending.rollId, spec: { kind: "dice", expression, critical: false } });
  return null;
}

// The roll worker saved the damage dice (decide.ts's recordRoll dispatcher tries this with the other between-fight rolls).
export function recordEnvironmentalDamageRoll(decision: Decision, pending: PendingEnvironmentalDamage, result: RollResult): Rejection | null {
  const spec: RollSpec = { kind: "dice", expression: pending.expression, critical: false };
  if (result.kind !== "dice" || !resultMatchesSpec(result, spec)) return { code: "rollMismatch" };
  return settle(decision, pending.characterId, pending.cause, pending.expression, pending.damageType, result.roll.total);
}

// Resistances and immunities the hero has from race and features (items are a fight's concern).
function heroTraits(decision: Decision, characterId: CharacterId): readonly Trait[] {
  const sheet = decision.state.characters[characterId];
  if (sheet === undefined) return [];
  const { content } = decision.ctx.rules;
  const race = sheet.race === undefined ? undefined : content.find(sheet.race);
  return [...(race === undefined ? [] : traitsOf(race)), ...sheet.features.flatMap((id) => { const feature = content.find(id); return feature === undefined ? [] : traitsOf(feature); })];
}

function settle(decision: Decision, characterId: CharacterId, cause: EnvironmentalCause, expression: DiceExpression | null, damageType: DamageType | null, rolled: number): Rejection | null {
  const { state, ctx } = decision;
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "staleNarration" };
  const current: HeroStatus = state.heroStatus[characterId] ?? { hp: sheet.maxHp, resources: defaultHeroResources(sheet, ctx.rules.content) };
  const taken = damageType === null ? rolled : Math.floor(rolled * damageMultiplier(heroTraits(decision, characterId), damageType));
  let hp: number;
  let dead: boolean;
  if (cause === "suffocation") {
    // Out of air, a hero drops to 0 hit points; one already there is gone.
    dead = current.hp <= 0;
    hp = 0;
  } else {
    const overflow = taken - current.hp;
    dead = taken > 0 && overflow >= sheet.maxHp;
    hp = Math.max(0, current.hp - taken);
  }
  const record: EnvironmentalDamageRecord = {
    id: `env-damage:${(state.damageCount ?? 0) + 1}`,
    characterId,
    cause,
    expression,
    rolled,
    taken: cause === "suffocation" ? current.hp : taken,
    hpAfter: dead ? 0 : hp,
    dead,
  };
  const heroStatus: HeroStatus = { ...current, hp: record.hpAfter, ...(dead ? { dead: true } : {}) };
  decision.emit({ kind: "environmentalDamageSettled", damage: record, heroStatus });
  decision.request({ kind: "deliver", delivery: { kind: "environmentalDamage", damageId: record.id } });
  return null;
}
