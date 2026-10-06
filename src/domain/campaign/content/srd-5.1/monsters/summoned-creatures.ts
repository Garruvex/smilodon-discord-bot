import { dice, plus } from "../../../dice/dice-expression.js";
import { defineMonster, type MonsterDefinition } from "../../../rules/content-definitions.js";

// Creatures a spell calls up. They are stat blocks for the engine, not roster
// entries: adventures cannot place them (see summonOnly).
const source = "SRD 5.1";

// What Spiritual Weapon calls up. It is a creature here so it takes turns like
// any other; the book makes it untargetable, so it is given a spirit's
// toughness instead. Its attack is a typical caster's (+5, force damage 1d8+3).
export const spiritualWeapon = defineMonster({
  id: "monster:spiritual-weapon",
  source,
  armorClass: 18,
  maxHp: 20,
  xp: 0,
  speed: 30,
  abilityScores: { str: 10, dex: 10, con: 10, int: 1, wis: 10, cha: 1 },
  attacks: [{ weapon: "item:spectral-weapon", toHit: 5, damage: plus(dice(1, 8), 3) }],
  tactic: "brute",
  traits: [],
  summonOnly: true,
});

// What Flaming Sphere calls up. The book has it ram a creature for a Dexterity save; here it makes an attack for the same 2d6 fire.
export const flamingSphere = defineMonster({
  id: "monster:flaming-sphere",
  source,
  armorClass: 13,
  maxHp: 10,
  xp: 0,
  speed: 30,
  abilityScores: { str: 10, dex: 10, con: 10, int: 1, wis: 10, cha: 1 },
  attacks: [{ weapon: "item:scorching-sphere", toHit: 5, damage: dice(2, 6) }],
  tactic: "brute",
  traits: [{ kind: "damageResistance", damageTypes: ["fire"] }],
  summonOnly: true,
});

export const srd51SummonedCreatures: readonly MonsterDefinition[] = [spiritualWeapon, flamingSphere];
