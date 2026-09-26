import type { DiceExpression } from "../dice/dice-expression.js";

// Passive rules a creature has, from whatever grants them: armor and shields,
// class features, monster stat blocks. One closed union, so each rule is
// implemented once in the engine and reused by every source (code structure:
// same system, different stats).
export type Trait =
  // Armor: base AC plus Dexterity, capped (null: no cap; 0: heavy armor).
  | { readonly kind: "armor"; readonly baseArmorClass: number; readonly dexterityCap: number | null }
  // Shield, Fighting Style (Defense), and similar flat AC bonuses.
  | { readonly kind: "armorClassBonus"; readonly amount: number }
  // Fighting Style (Dueling): extra damage with a one-handed melee weapon
  // and no other weapon. The milestone 0 heroes carry one melee weapon, so
  // the engine applies it when a hero has exactly one melee weapon.
  | { readonly kind: "meleeDamageBonus"; readonly amount: number }
  // Disciple of Life: healing spells of 1st level or higher restore extra HP.
  | { readonly kind: "healingBonus"; readonly flat: number; readonly perSpellLevel: number }
  // Once per turn, extra damage on a hit with a finesse or ranged weapon when
  // the attack has advantage, or an ally is next to the target.
  | { readonly kind: "sneakAttack"; readonly dice: DiceExpression }
  // Advantage on attacks while an ally is engaged with the target.
  | { readonly kind: "packTactics" }
  // Disengage (or Hide) as a bonus action.
  | { readonly kind: "nimbleEscape" };

export type TraitKind = Trait["kind"];
