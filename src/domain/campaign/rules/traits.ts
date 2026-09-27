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
  // the attack has advantage, or an ally is next to the target. The die
  // count scales with the rogue's level (attack-rules.ts's sneakDice), not
  // carried here, so this is a marker rather than a value.
  | { readonly kind: "sneakAttack" }
  // Advantage on attacks while an ally is engaged with the target.
  | { readonly kind: "packTactics" }
  // Disengage (or Hide) as a bonus action.
  | { readonly kind: "nimbleEscape" }
  // Extra Attack: the Attack action makes two weapon attacks instead of one.
  | { readonly kind: "extraAttack" }
  // Cunning Action: Dash or Disengage costs a bonus action instead of the
  // action, when the bonus action is still free (Hide is not modeled).
  | { readonly kind: "cunningAction" };

export type TraitKind = Trait["kind"];
