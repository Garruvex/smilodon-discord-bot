import type { DiceExpression } from "../dice/dice-expression.js";
import type { ContentId } from "./content-id.js";

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
    }
  | { readonly kind: "heal"; readonly target: EffectTarget; readonly amount: DiceExpression }
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
    };

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
