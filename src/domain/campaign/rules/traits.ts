import type { ContentId } from "./content-id.js";
import type { DamageType } from "./effects.js";

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
  // Extra Attack: the Attack action makes this many weapon attacks instead
  // of one (2 for most classes; a Fighter's own later features raise it
  // further). More than one granted source: the highest applies.
  | { readonly kind: "extraAttack"; readonly attacks: number }
  // Cunning Action: Dash or Disengage costs a bonus action instead of the
  // action, when the bonus action is still free (Hide is not modeled).
  | { readonly kind: "cunningAction" }
  // Divine Smite: a melee hit can spend a spell slot for bonus radiant damage.
  | { readonly kind: "divineSmite" }
  // Uncanny Dodge: halves an attack's damage. Simplified: applied
  // automatically whenever available (resolution.ts) rather than offered as
  // a reaction prompt — unlike Shield, it has no cost or downside to weigh,
  // so there is no real choice to ask about, only whether the reaction and
  // the trait are there.
  | { readonly kind: "uncannyDodge" }
  // Half damage of these types (rounded down); zero of these types (immune);
  // double these types (vulnerable). A monster stat block's Damage
  // Resistances/Immunities/Vulnerabilities, e.g. Skeleton's bludgeoning
  // vulnerability. Simplified: the SRD's "nonmagical weapons" qualifier on
  // some resistances is dropped (the engine has no notion of a magic
  // weapon), so those are granted as flat resistance to the damage type.
  | { readonly kind: "damageResistance"; readonly damageTypes: readonly DamageType[] }
  | { readonly kind: "damageImmunity"; readonly damageTypes: readonly DamageType[] }
  | { readonly kind: "damageVulnerability"; readonly damageTypes: readonly DamageType[] }
  // Never gains these conditions (Skeleton/Zombie's immunity to poisoned; a
  // monster's own immunity list, not a condition's, since only some holders
  // of a given condition are immune to it, e.g. undead but not the living).
  | { readonly kind: "conditionImmunity"; readonly conditions: readonly ContentId<"condition">[] };

export type TraitKind = Trait["kind"];

// The multiplier this creature's traits apply to damage of this type:
// resistance and vulnerability to the same type cancel out per the SRD, and
// immunity wins over either. Applied before rounding (damage.ts floors it).
export function damageMultiplier(traits: readonly Trait[], damageType: DamageType): number {
  if (traits.some((trait) => trait.kind === "damageImmunity" && trait.damageTypes.includes(damageType))) return 0;
  const resistant = traits.some((trait) => trait.kind === "damageResistance" && trait.damageTypes.includes(damageType));
  const vulnerable = traits.some((trait) => trait.kind === "damageVulnerability" && trait.damageTypes.includes(damageType));
  if (resistant === vulnerable) return 1;
  return resistant ? 0.5 : 2;
}

// Whether this creature's traits make it immune to gaining this specific
// condition (checked where a condition is about to be applied, not where its
// modifiers are read — an immune creature simply never receives the effect).
export function isImmuneToCondition(traits: readonly Trait[], conditionId: ContentId<"condition">): boolean {
  return traits.some((trait) => trait.kind === "conditionImmunity" && trait.conditions.includes(conditionId));
}
