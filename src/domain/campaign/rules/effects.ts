import type { EffectTrigger } from "./effect-triggers.js";
import type { DiceExpression } from "../dice/dice-expression.js";
import type { ContentId } from "./content-id.js";
import type { Modifier } from "./modifiers.js";

export const abilities = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof abilities)[number];

export const damageTypes = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
] as const;
export type DamageType = (typeof damageTypes)[number];

// Who an effect lands on, relative to the action that produced it.
export type EffectTarget = "self" | "target";

export type EffectDuration =
  | { readonly kind: "instant" }
  | { readonly kind: "rounds"; readonly count: number }
  | { readonly kind: "untilRemoved" };

// Closed union: the engine applies each kind with an exhaustive switch, so a
// new effect kind cannot ship without its handling.
export type Effect =
  | {
      readonly kind: "damage";
      readonly target: EffectTarget;
      readonly amount: DiceExpression;
      readonly damageType: DamageType;
      // On the avoided side of a save: half of what the same-numbered effect on the
      // landing side rolled (an area effect's "half as much on a successful save").
      readonly halfOfLand?: boolean;
      // Not doubled by a critical hit (Savage Attacks' one extra die).
      readonly uncritical?: boolean;
    }
  | { readonly kind: "heal"; readonly target: EffectTarget; readonly amount: DiceExpression }
  // Temporary hit points (False Life): taken before real ones, never added to them, and not stacking — the larger pool stays.
  | { readonly kind: "tempHp"; readonly target: EffectTarget; readonly amount: DiceExpression }
  | {
      readonly kind: "applyCondition";
      readonly target: EffectTarget;
      readonly condition: ContentId<"condition">;
      readonly duration: EffectDuration;
    }
  | {
      // Bless-style: add a die to the target's future rolls of the listed kinds.
      readonly kind: "bonusDie";
      readonly target: EffectTarget;
      readonly die: DiceExpression;
      readonly appliesTo: readonly ("attack" | "save")[];
      readonly duration: EffectDuration;
    }
  // Guiding Bolt: the next attack roll against the target before the end of
  // the caster's next turn has advantage.
  | { readonly kind: "nextAttackAdvantage"; readonly target: EffectTarget }
  // A rider that needs its own saving throw with a fixed DC, such as a
  // wolf's bite knocking the target prone.
  | {
      readonly kind: "conditionUnlessSave";
      readonly target: EffectTarget;
      readonly ability: Ability;
      readonly dc: number;
      readonly condition: ContentId<"condition">;
      // How long it lasts; until removed when absent.
      readonly duration?: EffectDuration;
    }
  // A lasting effect made of modifiers alone (Mage Armor's armor class, Faerie Fire's
  // advantage to hit): the same effect record a condition is, ending with its duration
  // or the caster's concentration.
  // Action Surge: one more action this turn. With attacks: that many more attacks instead (Flurry of Blows).
  | { readonly kind: "grantAction"; readonly target: EffectTarget; readonly attacks?: number }
  // Turns the target into this beast until its hit points run out or the spell's concentration ends (Polymorph).
  | { readonly kind: "polymorph"; readonly target: EffectTarget; readonly monsterId: ContentId<"monster"> }
  // Ends the target's effects that are one of these conditions (Lesser Restoration, escaping a grapple).
  | { readonly kind: "removeCondition"; readonly target: EffectTarget; readonly conditions: readonly ContentId<"condition">[] }
  // Changes how well lit the zone the target stands in is, for the rest of the fight (Light, Daylight, Darkness).
  | { readonly kind: "setLighting"; readonly target: EffectTarget; readonly lighting: "bright" | "dim" | "dark" }
  // One more spell slot of this level (Flexible Casting), gone with the next long rest.
  | { readonly kind: "gainSlot"; readonly target: EffectTarget; readonly level: number }
  // Flexible Casting the other way: a spell slot of this level becomes that many sorcery points.
  // The caster appears in the zone the casting was aimed at (Misty Step): no movement is spent and no one gets an opportunity attack.
  | { readonly kind: "teleport"; readonly target: EffectTarget }
  // A fallen hero rises again with this many hit points, or all of them (Revivify and the spells above it). Cast between fights only.
  | { readonly kind: "revive"; readonly target: EffectTarget; readonly hp: number | "full" }
  // A downed creature stops dying: stable at 0 hit points (Spare the Dying).
  | { readonly kind: "stabilize"; readonly target: EffectTarget }
  // Every lasting spell on the creature ends (Dispel Magic).
  | { readonly kind: "dispel"; readonly target: EffectTarget }
  // The zone the creature stands in becomes difficult terrain for the rest of the fight (Plant Growth, Spike Growth).
  | { readonly kind: "makeDifficult"; readonly target: EffectTarget }
  | { readonly kind: "convertSlot"; readonly target: EffectTarget; readonly level: number }
  // Feet of movement to use this turn (Misty Step's teleport is played as movement that provokes nothing).
  | { readonly kind: "grantMovement"; readonly target: EffectTarget; readonly feet: number }
  | {
      readonly kind: "applyModifiers";
      readonly target: EffectTarget;
      readonly modifiers: readonly Modifier[];
      readonly duration: EffectDuration;
      // What the effect does at turn boundaries (Spirit Guardians hurts its holder as its turn starts).
      readonly triggers?: readonly EffectTrigger[];
    }
  // Gains (positive) or removes (negative) this many levels of Exhaustion, a
  // 6-level stacking condition unlike every other one here (Greater
  // Restoration removes a level; a future travel/environment system would
  // be what usually grants one, since the engine has neither yet).
  // Destroy Undead: a monster worth no more experience than this is destroyed outright (Turn Undead, from cleric level 5).
  | { readonly kind: "destroy"; readonly target: EffectTarget; readonly maxXp: number }
  // Conjures creatures that fight on the caster's side until the fight ends (Conjure Animals). They act on their own turns.
  // Pushes the target away from the source: into the next zone if one lies within 10 feet and farther from them,
  // otherwise only out of any melee it was in.
  | { readonly kind: "push"; readonly target: EffectTarget }
  | { readonly kind: "summon"; readonly target: EffectTarget; readonly monsterId: ContentId<"monster">; readonly count: number; readonly permanent?: boolean }
  | { readonly kind: "exhaustion"; readonly target: EffectTarget; readonly amount: number };

export type EffectKind = Effect["kind"];

// The roll, if any, that decides between the landing and avoided effects.
// The bonus or DC comes from the source: the caster's spell attack bonus and
// save DC, or the weapon attack's to-hit.
export type CheckSpec =
  | { readonly kind: "spellAttack" }
  | { readonly kind: "weaponAttack" }
  | { readonly kind: "savingThrow"; readonly ability: Ability };

export interface ResolutionPlan {
  // null: the action simply happens (Cure Wounds) and onLand applies.
  readonly check: CheckSpec | null;
  // The effect lands: the attack hits, or the target fails its save.
  readonly onLand: readonly Effect[];
  // The effect is avoided: the attack misses, or the target succeeds on its
  // save (Sacred Flame: nothing; a "half damage on save" spell: half).
  readonly onAvoid: readonly Effect[];
}
