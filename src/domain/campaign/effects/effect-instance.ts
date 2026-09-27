import type { DiceExpression } from "../dice/dice-expression.js";
import type { ContentId } from "../rules/content-id.js";
import type { Ability, DamageType } from "../rules/effects.js";
import type { Modifier } from "../rules/modifiers.js";

// A lasting effect on a creature: a condition, a spell that outlasts its
// casting, a stance. One shape for all of them, so lifetimes, concentration
// and removal work the same way everywhere (docs/dnd-engine-architecture.md §5).

// When it ends. It follows one creature's turn: "source" is whoever caused it,
// "target" is whoever holds it. It ends at that creature's turn boundary in
// round untilRound or any later one, counted against the encounter's own
// round number so a pause cannot make it drift.
export interface EffectClock {
  readonly follows: "source" | "target";
  readonly boundary: "start" | "end";
  readonly untilRound: number;
}

// What happens when the same effect is applied to a creature that already has it:
// ignore the new one (conditions do not stack), replace the old one from the same
// source, or let both stand.
export type Stacking = "ignore" | "replace" | "coexist";

// What an effect does at a turn boundary: damage its holder (poison, burning), or
// give it a saving throw that ends the effect (Hold Person). The dice go through
// saved rolls like any other, so a restart never rerolls.
export type TriggerAction =
  | { readonly kind: "damage"; readonly amount: DiceExpression; readonly damageType: DamageType }
  | { readonly kind: "saveToEnd"; readonly ability: Ability; readonly dc: number };

// Runs at the start or end of one creature's turn: the source's or the holder's.
export interface EffectTrigger {
  readonly follows: "source" | "target";
  readonly boundary: "start" | "end";
  readonly does: TriggerAction;
}

export interface EffectInstance {
  readonly id: string;
  // What it is: a condition ("condition:prone"), a spell ("spell:bless"), a stance ("action:dodge").
  readonly definition: string;
  readonly sourceId: string;
  // Conditions its holder has because of it (each brings what it includes, through content).
  readonly conditions: readonly ContentId<"condition">[];
  // What it does besides its conditions' modifiers.
  readonly modifiers: readonly Modifier[];
  readonly clock: EffectClock | null;
  // What it does at turn boundaries, in the order listed.
  readonly triggers: readonly EffectTrigger[];
  // Ends with the source's concentration on this resolution.
  readonly concentrationId: string | null;
  readonly stacking: Stacking;
}
