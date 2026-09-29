import type { HeroResources } from "../character/hero-status.js";
import type { SpellDefinition } from "../rules/content-definitions.js";

// The rules of spellcasting that do not depend on where a fight is happening:
// slots, how many targets, whom a spell may name, and what keeps concentration.
// They take plain facts so that combat, reactions and (later) casting outside a
// fight all ask the same questions (docs/dnd-engine-architecture.md §3, Magic).

// Spell slots left, by slot level.
export type SpellSlots = Readonly<Record<number, number>>;

// A caster's ordinary slots and their Pact Magic slots, summed level by
// level, for asking "can this spell be cast at all right now" without
// caring which pool it would draw from (spending — evolve-combat.ts's
// spendSlot — does care, and always prefers the ordinary pool first).
export function mergeSlots(spellSlots: SpellSlots, pactSlots: SpellSlots): SpellSlots {
  const levels = new Set([...Object.keys(spellSlots), ...Object.keys(pactSlots)].map(Number));
  return Object.fromEntries([...levels].map((level) => [level, (spellSlots[level] ?? 0) + (pactSlots[level] ?? 0)]));
}

// What a spell's target rules need to know about a creature.
export interface SpellParty {
  readonly id: string;
  readonly side: "party" | "foes";
  readonly zoneId: string;
}

export type SpellTargetProblem = "invalidTarget" | "outOfRange";

// How many creatures a spell may name at a slot level (upcasting adds targets to some spells).
export function spellMaxTargets(spell: SpellDefinition, slotLevel: number): number {
  const extra = spell.level === 0 ? 0 : (spell.targeting.countPerHigherSlot ?? 0) * (slotLevel - spell.level);
  return spell.targeting.relation === "self" ? 1 : spell.targeting.count + extra;
}

// Where an innate spell's uses left are counted (resources.featureUses).
export { innateUseKey } from "../rules/traits.js";

// A slot is unavailable when it is too low for the spell, empty, or (for a cantrip) not zero.
export function slotUnavailable(spell: SpellDefinition, slots: SpellSlots, slotLevel: number): boolean {
  return spell.level === 0 ? slotLevel !== 0 : slotLevel < spell.level || (slots[slotLevel] ?? 0) < 1;
}

// Spends one slot of the given level, off the ordinary pool first and only
// falling back to Pact Magic if that level isn't there: a fixed spending order,
// not a player choice, so casting a Warlock or multiclass hero's spell needs no
// new command surface. Casting in a fight and outside one spend the same way.
export function spendSlot(resources: HeroResources, slotLevel: number): HeroResources {
  if ((resources.spellSlots[slotLevel] ?? 0) > 0) {
    return { ...resources, spellSlots: { ...resources.spellSlots, [slotLevel]: (resources.spellSlots[slotLevel] ?? 0) - 1 } };
  }
  const pactSlots = resources.pactSlots ?? {};
  return { ...resources, pactSlots: { ...pactSlots, [slotLevel]: Math.max(0, (pactSlots[slotLevel] ?? 0) - 1) } };
}

// Every slot level the spell can be cast at now: [0] for a cantrip, otherwise each level that fits and has a slot left.
export function castableSlotLevels(spell: SpellDefinition, slots: SpellSlots): readonly number[] {
  const levels = spell.level === 0 ? [0] : Object.keys(slots).map(Number).sort((a, b) => a - b);
  return levels.filter((level) => !slotUnavailable(spell, slots, level));
}

// The lowest slot the spell can be cast at now, or undefined when none is left.
export function lowestSlot(spell: SpellDefinition, slots: SpellSlots): number | undefined {
  return castableSlotLevels(spell, slots)[0];
}

// Whether a creature may be named as a target: the spell's relation (enemy, ally, self) and its reach.
// distanceFeet is null when no path connects them.
export function spellTargetProblem(spell: SpellDefinition, caster: SpellParty, target: SpellParty | undefined, present: boolean, distanceFeet: number | null): SpellTargetProblem | null {
  if (target === undefined || !present) return "invalidTarget";
  if (spell.targeting.relation === "enemy" && target.side === caster.side) return "invalidTarget";
  if (spell.targeting.relation === "ally-or-self" && target.side !== caster.side) return "invalidTarget";
  const inReach =
    spell.range.kind === "self"
      ? target.id === caster.id
      : spell.range.kind === "touch"
        ? // Touch: the positioning contract has no ally adjacency, so any creature in the caster's zone is within reach.
          target.id === caster.id || target.zoneId === caster.zoneId
        : target.id === caster.id || (distanceFeet ?? Infinity) <= spell.range.feet;
  return inReach ? null : "outOfRange";
}

// The Constitution save that keeps concentration after damage: 10, or half the damage if that is more.
export function concentrationDc(damage: number): number {
  return Math.max(10, Math.floor(damage / 2));
}
