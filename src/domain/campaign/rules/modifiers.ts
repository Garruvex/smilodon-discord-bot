import type { DiceExpression } from "../dice/dice-expression.js";
import type { Ability } from "./effects.js";

// What a lasting effect or condition does, from a fixed vocabulary. The rule
// queries (effects/effect-queries.ts) read these and nothing else, so no rule
// ever names a condition; a condition is content that lists modifiers. A
// behavior this vocabulary cannot say is a new engine capability, added here
// and to the queries together (docs/dnd-engine-architecture.md §5).

export type RollBias = "advantage" | "disadvantage";

// Relative to the attacker's distance from the target: "within5" is melee reach.
export type Reach = "any" | "within5" | "beyond5";

export type Modifier =
  // No actions, bonus actions or reactions.
  | { readonly kind: "blocksActions" }
  // Speed becomes 0.
  | { readonly kind: "speedZero" }
  // The holder's own attack rolls.
  | { readonly kind: "ownAttacks"; readonly mode: RollBias }
  // Attack rolls against the holder. usesUp: the first attack against it uses the effect up.
  | { readonly kind: "attacksAgainst"; readonly mode: RollBias; readonly reach: Reach; readonly usesUp?: true }
  // The holder's saving throws of one ability, or of any.
  | { readonly kind: "saves"; readonly ability: Ability | "any"; readonly mode: RollBias }
  // The holder fails these saving throws automatically.
  | { readonly kind: "autoFailSaves"; readonly abilities: readonly Ability[] }
  // A hit against the holder from this reach is a critical hit.
  | { readonly kind: "critsAgainst"; readonly reach: Reach }
  // Adds a die to the holder's rolls of the listed kinds (Bless).
  | { readonly kind: "bonusDie"; readonly die: DiceExpression; readonly appliesTo: readonly ("attack" | "save")[]; readonly source: string }
  // Leaving a hostile's reach provokes no opportunity attack (Disengage).
  | { readonly kind: "avoidsOpportunityAttacks" }
  // Adds to the holder's armor class (Shield).
  | { readonly kind: "acBonus"; readonly amount: number };
