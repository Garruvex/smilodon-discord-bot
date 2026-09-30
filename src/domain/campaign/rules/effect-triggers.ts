import type { DiceExpression } from "../dice/dice-expression.js";
import type { Ability, DamageType } from "./effects.js";

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
