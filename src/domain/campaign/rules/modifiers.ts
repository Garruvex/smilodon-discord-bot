import type { DiceExpression } from "../dice/dice-expression.js";
import type { ContentId } from "./content-id.js";
import type { Ability, DamageType } from "./effects.js";

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
  // A flat bonus to the holder's own attack rolls (Sacred Weapon).
  | { readonly kind: "attackBonus"; readonly amount: number }
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
  | { readonly kind: "acBonus"; readonly amount: number }
  // Takes half damage of these types while it lasts (Rage).
  | { readonly kind: "damageResistance"; readonly damageTypes: readonly DamageType[] }
  // Adds to the holder's melee weapon damage (Rage).
  | { readonly kind: "meleeDamageBonus"; readonly amount: number }
  // The holder cannot attack, or target with a spell, whoever caused this
  // effect (Charmed). Unlike every other modifier here, this one only means
  // anything read against the specific effect that granted it — a generic
  // "the holder is Charmed" fact says nothing about who by — so it is not
  // read through modifiersOf()'s flattened list; see forbiddenAttackTargets().
  | { readonly kind: "cannotTargetSource" }
  // Metamagic the sorcerer has readied for the next spell they cast (it is used up by the casting).
  | { readonly kind: "metamagic"; readonly option: MetamagicOption }
  // A monk's readied Stunning Strike: the next melee weapon hit may stun (used up by the attack).
  | { readonly kind: "stunningStrike" }
  // More feet of movement every turn while the effect lasts (Longstrider).
  | { readonly kind: "speedBonus"; readonly amount: number }
  // Unseen by the foes: attacks against the holder have disadvantage and its own attacks advantage; the first attack or spell ends it (Hide).
  | { readonly kind: "hidden" }
  // Marked by whoever cast the spell (Hunter's Mark): that caster's weapon hits deal 1d6 more damage.
  | { readonly kind: "marked" }
  // Cannot gain these conditions while the effect lasts (Mindless Rage).
  | { readonly kind: "conditionImmunity"; readonly conditions: readonly ContentId<"condition">[] }
  // A wizard's readied Overchannel: the next spell of the 1st to 5th level deals its maximum damage or healing (used up by the casting).
  | { readonly kind: "overchannel" };

export type MetamagicOption = "quickened" | "twinned" | "heightened" | "empowered" | "extended" | "subtle";
