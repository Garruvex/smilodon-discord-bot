// The rules an attack or spell is built from: its plan, advantage and disadvantage, and Sneak Attack.
import { assertNever } from "../../core/assert-never.js";
import { engagedWith, isActive, type Combatant, type EncounterState, type ResolutionSource } from "../../combat/combat-state.js";
import { attackBias, effectsUsedUpByAttack, type ConditionLookup } from "../../effects/effect-queries.js";
import { distanceBetween, engagedDistance } from "../../combat/positioning.js";
import type { D20TestSpec } from "../../dice/d20-test.js";
import type { combine } from "../../dice/dice-expression.js";
import { dice, plus } from "../../dice/dice-expression.js";
import { resolveRollMode } from "../../dice/roll.js";
import type { Effect, ResolutionPlan } from "../../rules/effects.js";
import type { Decision } from "../decision.js";

export function planFor(decision: Decision, actor: Combatant, source: ResolutionSource): ResolutionPlan | null {
  const content = decision.ctx.rules.content;
  switch (source.kind) {
    case "weapon": {
      // Divine Smite's bonus damage is not here: it depends on a slot that
      // may only be chosen after this hit lands (engine/combat/smite.ts), so
      // resolution.ts's landEffects() adds it at apply time instead, past
      // the plan this function fixes at declare time.
      return {
        check: { kind: "weaponAttack" },
        onLand: [{ kind: "damage", target: "target", amount: source.option.damage, damageType: source.option.damageType }, ...source.option.onHit],
        onAvoid: [],
      };
    }
    case "spell": {
      const spell = content.get(source.spellId);
      const plan = spell.plan({ slotLevel: source.slotLevel, casterLevel: actor.spellcasting?.casterLevel ?? actor.level, spellcastingModifier: actor.spellcasting?.modifier ?? 0 });
      // Disciple of Life and similar: extra healing from leveled spells.
      const bonus = source.slotLevel > 0 ? healingBonus(actor, source.slotLevel) : 0;
      if (bonus === 0) return plan;
      const boost = (effect: Effect): Effect => (effect.kind === "heal" ? { ...effect, amount: plus(effect.amount, bonus) } : effect);
      return { ...plan, onLand: plan.onLand.map(boost), onAvoid: plan.onAvoid.map(boost) };
    }
    case "feature": {
      const feature = content.get(source.featureId);
      return feature.action?.plan({ level: actor.level }) ?? null;
    }
    case "area": {
      const area = source.area;
      return {
        check: { kind: "savingThrow", ability: area.ability },
        onLand: [{ kind: "damage", target: "target", amount: area.damage, damageType: area.damageType }],
        onAvoid: area.halfOnSave ? [{ kind: "damage", target: "target", amount: area.damage, damageType: area.damageType, halfOfLand: true }] : [],
      };
    }
    default:
      return assertNever(source);
  }
}

export function healingBonus(actor: Combatant, spellLevel: number): number {
  return actor.traits.reduce((sum, trait) => sum + (trait.kind === "healingBonus" ? trait.flat + trait.perSpellLevel * spellLevel : 0), 0);
}

export function rangedAttack(source: ResolutionSource): boolean {
  if (source.kind === "weapon") return source.option.range.kind === "ranged";
  return true;
}

// Advantage and disadvantage on an attack (2014 rules), and any "next
// attack has advantage" effects the attack uses up.
export function attackMode(
  encounter: EncounterState,
  attacker: Combatant,
  target: Combatant,
  ranged: boolean,
  longShot: boolean,
  lookup: ConditionLookup,
): { readonly mode: D20TestSpec["mode"]; readonly consumed: readonly string[] } {
  let advantage = 0;
  let disadvantage = longShot ? 1 : 0;
  const distance = distanceBetween(encounter, attacker.id, target.id) ?? Infinity;
  // What conditions and lasting effects on either creature add (prone, unconscious, dodging, a Guiding Bolt...).
  const bias = attackBias(attacker, target, lookup, distance <= engagedDistance);
  advantage += bias.advantage;
  disadvantage += bias.disadvantage;
  if (ranged) {
    const threatened = engagedWith(encounter, attacker.id).some((other) => other.side !== attacker.side && isActive(other));
    if (threatened) disadvantage += 1;
  }
  for (const trait of attacker.traits) {
    if (trait.kind !== "packTactics") continue;
    const allyEngaged = engagedWith(encounter, target.id).some(
      (other) => other.side === attacker.side && other.id !== attacker.id && isActive(other),
    );
    if (allyEngaged) advantage += 1;
  }
  return { mode: resolveRollMode(advantage, disadvantage), consumed: effectsUsedUpByAttack(target) };
}

// Sneak Attack (2014): once per turn, with a finesse or ranged weapon, when
// the attack has advantage, or an ally is next to the target and the attack
// does not have disadvantage.
export function sneakAttackEligible(
  encounter: EncounterState,
  attacker: Combatant,
  target: Combatant,
  finesse: boolean,
  mode: D20TestSpec["mode"],
): boolean {
  if (!finesse || attacker.sneakAttackUsed || sneakDice(attacker) === null) return false;
  if (mode === "advantage") return true;
  if (mode === "disadvantage") return false;
  return engagedWith(encounter, target.id).some((other) => other.side === attacker.side && other.id !== attacker.id && isActive(other));
}

// SRD 5.1: 1d6 at level 1, plus one more every two levels after (2d6 at 3,
// 3d6 at 5, and so on through 10d6 at 19).
export function sneakDice(attacker: Combatant | undefined): ReturnType<typeof combine> | null {
  if (attacker === undefined || !attacker.traits.some((trait) => trait.kind === "sneakAttack")) return null;
  return dice(Math.ceil(attacker.level / 2), 6);
}

export function effectForKey(plan: ResolutionPlan, key: string): Effect | undefined {
  const [, listName, index] = /^(?:rider:[^:]+:)?(land|avoid):(\d+)$/.exec(key) ?? [];
  const list = listName === "land" ? plan.onLand : listName === "avoid" ? plan.onAvoid : [];
  return list[Number(index)];
}
