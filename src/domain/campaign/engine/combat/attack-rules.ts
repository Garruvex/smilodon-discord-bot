// The rules an attack or spell is built from: its plan, advantage and disadvantage, and Sneak Attack.
import { assertNever } from "../../core/assert-never.js";
import { engagedWith, isActive, type Combatant, type EncounterState, type ResolutionSource } from "../../combat/combat-state.js";
import { attackBias, canAct, conditionLookup, effectsUsedUpByAttack, meleeDamageBonusOf, type ConditionLookup } from "../../effects/effect-queries.js";
import type { DiceExpression } from "../../dice/dice-expression.js";
import { distanceBetween, engagedDistance } from "../../combat/positioning.js";
import type { D20TestSpec } from "../../dice/d20-test.js";
import type { combine } from "../../dice/dice-expression.js";
import { dice, plus } from "../../dice/dice-expression.js";
import { resolveRollMode } from "../../dice/roll.js";
import type { Effect, ResolutionPlan } from "../../rules/effects.js";
import type { SaveContext } from "../../rules/traits.js";
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
        onLand: [{ kind: "damage", target: "target", amount: withRageBonus(source.option.damage, source.option.range.kind === "melee", actor, decision), damageType: source.option.damageType }, ...source.option.onHit],
        onAvoid: [],
      };
    }
    case "spell": {
      const spell = content.get(source.spellId);
      const casterLevel = actor.spellcasting?.casterLevel ?? actor.level;
      const planned = spell.plan({ slotLevel: source.slotLevel, casterLevel, spellcastingModifier: actor.spellcasting?.modifier ?? 0 });
      // Extended Spell: timed effects last twice as long.
      const stretch = (effect: Effect): Effect =>
        source.metamagic === "extended" && "duration" in effect && effect.duration?.kind === "rounds" ? { ...effect, duration: { kind: "rounds", count: effect.duration.count * 2 } } : effect;
      const cast = source.metamagic === "extended" ? { ...planned, onLand: planned.onLand.map(stretch), onAvoid: planned.onAvoid.map(stretch) } : planned;
      // Agonizing Blast: the modifier on every beam (this build fires them as one bolt of that many dice).
      const beams = casterLevel >= 17 ? 4 : casterLevel >= 11 ? 3 : casterLevel >= 5 ? 2 : 1;
      const agonizing = source.spellId === "spell:eldritch-blast" && actor.traits.some((trait) => trait.kind === "agonizingBlast") ? (actor.spellcasting?.modifier ?? 0) * beams : 0;
      // Potent Cantrip: the save that would have avoided a damaging cantrip still takes half.
      const potent = spell.level === 0 && cast.check?.kind === "savingThrow" && cast.onAvoid.length === 0 && actor.traits.some((trait) => trait.kind === "potentCantrip");
      const halved = potent ? { ...cast, onAvoid: cast.onLand.flatMap((effect): Effect[] => (effect.kind === "damage" ? [{ ...effect, halfOfLand: true }] : [])) } : cast;
      const plan = agonizing === 0 ? halved : { ...halved, onLand: cast.onLand.map((effect): Effect => (effect.kind === "damage" ? { ...effect, amount: plus(effect.amount, agonizing) } : effect)) };
      // Empowered Evocation, Empowered Spell and Elemental Affinity: the modifier on one damage roll.
      const affinity = plan.onLand.some((effect) => effect.kind === "damage" && actor.traits.some((trait) => trait.kind === "elementalAffinity" && trait.damageType === effect.damageType));
      const empowered = (spell.school === "evocation" && actor.traits.some((trait) => trait.kind === "empoweredEvocation")) || affinity || source.metamagic === "empowered" ? (actor.spellcasting?.modifier ?? 0) : 0;
      const firstDamage = plan.onLand.findIndex((effect) => effect.kind === "damage");
      const empoweredPlan =
        empowered === 0 || firstDamage < 0 ? plan : { ...plan, onLand: plan.onLand.map((effect, index): Effect => (index === firstDamage && effect.kind === "damage" ? { ...effect, amount: plus(effect.amount, empowered) } : effect)) };
      // Disciple of Life and similar: extra healing from leveled spells.
      const bonus = source.slotLevel > 0 ? healingBonus(actor, source.slotLevel) : 0;
      const boost = (effect: Effect): Effect => (effect.kind === "heal" ? { ...effect, amount: plus(effect.amount, bonus) } : effect);
      const boosted = bonus === 0 ? empoweredPlan : { ...empoweredPlan, onLand: empoweredPlan.onLand.map(boost), onAvoid: empoweredPlan.onAvoid.map(boost) };
      // Overchannel and Supreme Healing: the dice give their most.
      const supreme = actor.traits.some((trait) => trait.kind === "supremeHealing");
      const most = (effect: Effect): Effect =>
        (effect.kind === "damage" && source.maximized === true) || (effect.kind === "heal" && (source.maximized === true || supreme)) ? { ...effect, amount: maximumOf(effect.amount) } : effect;
      return source.maximized === true || supreme ? { ...boosted, onLand: boosted.onLand.map(most), onAvoid: boosted.onAvoid.map(most) } : boosted;
    }
    case "feature": {
      const feature = content.get(source.featureId);
      return feature.action?.plan({ level: actor.level, spellcastingModifier: actor.spellcasting?.modifier ?? 0 }) ?? null;
    }
    case "item": {
      const item = content.find(source.itemId);
      return item?.kind === "item" && item.itemType === "potion" && item.effects !== undefined ? { check: null, onLand: item.effects, onAvoid: [] } : null;
    }
    case "area": {
      const area = source.area;
      const damage: Effect[] = area.damage === undefined || area.damageType === undefined ? [] : [{ kind: "damage", target: "target", amount: area.damage, damageType: area.damageType }];
      const condition: Effect[] = area.condition === undefined ? [] : [{ kind: "applyCondition", target: "target", condition: area.condition, duration: { kind: "rounds", count: 10 } }];
      return {
        check: { kind: "savingThrow", ability: area.ability },
        onLand: [...damage, ...condition],
        onAvoid: area.halfOnSave && area.damage !== undefined && area.damageType !== undefined ? [{ kind: "damage", target: "target", amount: area.damage, damageType: area.damageType, halfOfLand: true }] : [],
      };
    }
    default:
      return assertNever(source);
  }
}

// A dice expression with every die at its highest face.
function maximumOf(expression: DiceExpression): DiceExpression {
  return { terms: [], modifier: expression.modifier + expression.terms.reduce((sum, term) => sum + term.count * term.sides, 0) };
}

// Rage (and similar lasting effects): a flat bonus to melee weapon damage.
function withRageBonus(damage: DiceExpression, melee: boolean, actor: Combatant, decision: Decision): DiceExpression {
  const bonus = melee ? meleeDamageBonusOf(actor, conditionLookup(decision.ctx.rules.content)) : 0;
  return bonus === 0 ? damage : plus(damage, bonus);
}

// What a saving throw against this plan is against, for racial save advantage (Fey Ancestry, Dwarven Resilience...).
export function saveContextOf(plan: ResolutionPlan, source: ResolutionSource): SaveContext {
  const effects = [...plan.onLand, ...plan.onAvoid];
  return {
    conditions: effects.flatMap((effect) => (effect.kind === "applyCondition" || effect.kind === "conditionUnlessSave" ? [effect.condition] : [])),
    damageTypes: effects.flatMap((effect) => (effect.kind === "damage" ? [effect.damageType] : [])),
    magic: source.kind === "spell",
  };
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
  // Darkness: a creature that cannot see in the dark fights at disadvantage in a dark zone, or against one in it.
  const darkAt = (zoneId: string): boolean => encounter.zones.some((zone) => zone.id === zoneId && zone.lighting === "dark");
  if ((darkAt(attacker.zoneId) || darkAt(target.zoneId)) && !attacker.traits.some((trait) => trait.kind === "darkvision")) disadvantage += 1;
  // Sunlight Sensitivity, and Blood Frenzy against a wounded creature.
  const brightAt = (zoneId: string): boolean => encounter.zones.some((zone) => zone.id === zoneId && zone.lighting === "bright");
  if (attacker.traits.some((trait) => trait.kind === "sunlightSensitivity") && (brightAt(attacker.zoneId) || brightAt(target.zoneId))) disadvantage += 1;
  if (!ranged && target.hp < target.maxHp && attacker.traits.some((trait) => trait.kind === "bloodFrenzy")) advantage += 1;
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
  // Elusive: nothing gives advantage against a creature that can still act.
  if (target.traits.some((trait) => trait.kind === "elusive") && canAct(target, lookup)) advantage = 0;
  return { mode: resolveRollMode(advantage, disadvantage), consumed: effectsUsedUpByAttack(target) };
}

// Cover: creatures in a zone with cover are harder to hit and to catch in an effect from another zone.
export function coverBonus(encounter: EncounterState, sourceId: string, target: Combatant): number {
  const source = encounter.combatants[sourceId];
  if (source === undefined || source.zoneId === target.zoneId) return 0;
  const cover = encounter.zones.find((zone) => zone.id === target.zoneId)?.cover;
  return cover === "three-quarters" ? 5 : cover === "half" ? 2 : 0;
}

// Protection (Fighting Style): a creature standing beside the target, with its reaction to spare, that can throw the attack off.
export function protectorFor(encounter: EncounterState, target: Combatant, lookup: ConditionLookup): Combatant | undefined {
  return Object.values(encounter.combatants).find(
    (other) => other.id !== target.id && other.side === target.side && other.zoneId === target.zoneId && isActive(other) && other.hp > 0 && other.budget.reaction && other.traits.some((trait) => trait.kind === "protectionStyle") && canAct(other, lookup),
  );
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
  if (attacker === undefined) return null;
  if (attacker.traits.some((trait) => trait.kind === "sneakAttack")) return dice(Math.ceil(attacker.level / 2), 6);
  return attacker.traits.some((trait) => trait.kind === "colossusSlayer") ? dice(1, 8) : null;
}

// Colossus Slayer: a weapon attack on a creature that is missing hit points, once per turn (it shares Sneak Attack's slot).
// Aura of Protection: the best bonus among the conscious allies (itself included) standing in the target's zone.
export function auraBonusFor(encounter: EncounterState, target: Combatant): number {
  let best = 0;
  for (const other of Object.values(encounter.combatants)) {
    if (other.side !== target.side || other.zoneId !== target.zoneId || other.hp <= 0) continue;
    for (const trait of other.traits) if (trait.kind === "auraOfProtection") best = Math.max(best, trait.bonus);
  }
  return best;
}

export function colossusSlayerEligible(attacker: Combatant, target: Combatant): boolean {
  return !attacker.sneakAttackUsed && attacker.traits.some((trait) => trait.kind === "colossusSlayer") && target.hp < target.maxHp;
}

export function effectForKey(plan: ResolutionPlan, key: string): Effect | undefined {
  const [, listName, index] = /^(?:rider:[^:]+:)?(land|avoid):(\d+)$/.exec(key) ?? [];
  const list = listName === "land" ? plan.onLand : listName === "avoid" ? plan.onAvoid : [];
  return list[Number(index)];
}
