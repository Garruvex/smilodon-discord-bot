import { dice, plus } from "../../../dice/dice-expression.js";
import { defineMonster, type MonsterDefinition } from "../../../rules/content-definitions.js";

// The starter adventure's monsters (SRD 5.1, Monsters). Attack bonuses and
// damage are the stat block's. Traits the engine does not implement yet are
// listed per entry and join with the combat rules that need them; until
// then these monsters are slightly weaker than written.
const source = "SRD 5.1";

// Nimble Escape is used as a bonus-action Disengage; Hide is not modeled.
export const goblin = defineMonster({
  id: "monster:goblin",
  source,
  armorClass: 15,
  maxHp: 7,
  xp: 50,
  speed: 30,
  abilityScores: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  attacks: [
    { weapon: "item:scimitar", toHit: 4, damage: plus(dice(1, 6), 2) },
    { weapon: "item:shortbow", toHit: 4, damage: plus(dice(1, 6), 2) },
  ],
  tactic: "skirmisher",
  traits: [{ kind: "nimbleEscape" }],
});

export const wolf = defineMonster({
  id: "monster:wolf",
  source,
  armorClass: 13,
  maxHp: 11,
  xp: 50,
  speed: 40,
  abilityScores: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 4,
      damage: plus(dice(2, 4), 2),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "str", dc: 11, condition: "condition:prone" }],
    },
  ],
  tactic: "brute",
  traits: [{ kind: "packTactics" }],
  beast: { challengeRating: 0.25, flies: false, swims: false },
});

// The starter adventure's leader, Skarn. Brute is already part of the
// morningstar's 2d8 melee damage. Not modeled: Surprise Attack (the
// engine has no surprise rules yet).
export const bugbear = defineMonster({
  id: "monster:bugbear",
  source,
  armorClass: 16,
  maxHp: 27,
  xp: 200,
  speed: 30,
  abilityScores: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 },
  attacks: [
    { weapon: "item:morningstar", toHit: 4, damage: plus(dice(2, 8), 2) },
    { weapon: "item:javelin", toHit: 4, damage: plus(dice(1, 6), 2), range: { kind: "ranged", normal: 30, long: 120 } },
  ],
  tactic: "brute",
  traits: [],
});

// The bite's poison damage is not modeled; a failed CON save leaves the
// target Poisoned (disadvantage on attack rolls) for the rest of the fight.
export const giantWolfSpider = defineMonster({
  id: "monster:giant-wolf-spider",
  source,
  armorClass: 13,
  maxHp: 11,
  xp: 100,
  speed: 40,
  abilityScores: { str: 12, dex: 16, con: 13, int: 3, wis: 12, cha: 4 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 3,
      damage: plus(dice(1, 6), 1),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "con", dc: 11, condition: "condition:poisoned" }],
    },
  ],
  tactic: "brute",
  traits: [],
  beast: { challengeRating: 0.25, flies: false, swims: false },
});

// Added for engine-robustness pass (step 8): more common low-level monsters,
// same shape as the starter four.

export const kobold = defineMonster({
  id: "monster:kobold",
  source,
  armorClass: 12,
  maxHp: 5,
  xp: 25,
  speed: 30,
  abilityScores: { str: 7, dex: 15, con: 9, int: 8, wis: 7, cha: 8 },
  attacks: [{ weapon: "item:dagger", toHit: 4, damage: plus(dice(1, 4), 2) }],
  tactic: "skirmisher",
  traits: [{ kind: "packTactics" }],
});

export const giantRat = defineMonster({
  id: "monster:giant-rat",
  source,
  armorClass: 12,
  maxHp: 7,
  xp: 25,
  speed: 30,
  abilityScores: { str: 7, dex: 15, con: 11, int: 2, wis: 10, cha: 4 },
  attacks: [{ weapon: "item:bite", toHit: 4, damage: plus(dice(1, 4), 2) }],
  tactic: "brute",
  traits: [{ kind: "packTactics" }],
  beast: { challengeRating: 0.125, flies: false, swims: false },
});

// Not modeled: Undead Fortitude (the engine has no "drop to 1 HP instead of 0
// on a failed CON save" mechanic yet).
export const zombie = defineMonster({
  id: "monster:zombie",
  source,
  armorClass: 8,
  maxHp: 22,
  xp: 50,
  speed: 20,
  abilityScores: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  attacks: [{ weapon: "item:slam", toHit: 3, damage: plus(dice(1, 6), 1) }],
  tactic: "brute",
  traits: [{ kind: "damageImmunity", damageTypes: ["poison"] }, { kind: "conditionImmunity", conditions: ["condition:poisoned"] }],
});

// Not modeled: bonus-action move toward the nearest enemy on its turn (Aggressive).
export const orc = defineMonster({
  id: "monster:orc",
  source,
  armorClass: 13,
  maxHp: 15,
  xp: 100,
  speed: 30,
  abilityScores: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 },
  attacks: [{ weapon: "item:greataxe", toHit: 5, damage: plus(dice(1, 12), 3) }],
  tactic: "brute",
  traits: [],
});

// Not modeled: condition immunity to Exhaustion (the engine doesn't
// implement Exhaustion itself, a multi-level stacking condition).
export const skeleton = defineMonster({
  id: "monster:skeleton",
  source,
  armorClass: 13,
  maxHp: 13,
  xp: 50,
  speed: 30,
  abilityScores: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 },
  attacks: [
    { weapon: "item:shortsword", toHit: 4, damage: plus(dice(1, 6), 2) },
    { weapon: "item:shortbow", toHit: 4, damage: plus(dice(1, 6), 2) },
  ],
  tactic: "skirmisher",
  traits: [
    { kind: "damageVulnerability", damageTypes: ["bludgeoning"] },
    { kind: "damageImmunity", damageTypes: ["poison"] },
    { kind: "conditionImmunity", conditions: ["condition:poisoned"] },
  ],
});

// Added for engine-robustness pass (step 14): more monsters across a wider
// CR range. Not modeled: Martial Advantage (extra damage when an ally is
// adjacent to the target — Sneak Attack's own condition, not yet a shared
// monster trait).
export const hobgoblin = defineMonster({
  id: "monster:hobgoblin",
  source,
  armorClass: 18,
  maxHp: 11,
  xp: 100,
  speed: 30,
  abilityScores: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  attacks: [{ weapon: "item:longsword", toHit: 3, damage: plus(dice(1, 8), 1) }],
  tactic: "brute",
  traits: [],
});

export const ogre = defineMonster({
  id: "monster:ogre",
  source,
  armorClass: 11,
  maxHp: 59,
  xp: 450,
  speed: 40,
  abilityScores: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
  attacks: [{ weapon: "item:greatclub", toHit: 6, damage: plus(dice(2, 8), 4) }],
  tactic: "brute",
  traits: [],
});

// Not modeled: the "reduces the target's hit point maximum" half of Life
// Drain (no mechanic for a temporary maximum HP change yet), Incorporeal
// Movement, and condition immunity to Exhaustion/Petrified/Unconscious (the
// first two the engine doesn't implement; Unconscious is derived from HP,
// not a condition a trait can block). Damage resistances drop the SRD's
// "from nonmagical attacks" qualifier, the same liberty Skeleton/Zombie take.
export const specter = defineMonster({
  id: "monster:specter",
  source,
  armorClass: 12,
  maxHp: 22,
  xp: 200,
  speed: 50,
  abilityScores: { str: 1, dex: 14, con: 11, int: 10, wis: 10, cha: 11 },
  attacks: [{ weapon: "item:life-drain", toHit: 4, damage: plus(dice(3, 6), 2) }],
  tactic: "brute",
  traits: [
    { kind: "damageResistance", damageTypes: ["acid", "cold", "fire", "lightning", "thunder", "bludgeoning", "piercing", "slashing"] },
    { kind: "damageImmunity", damageTypes: ["necrotic", "poison"] },
    { kind: "conditionImmunity", conditions: ["condition:charmed", "condition:frightened", "condition:grappled", "condition:paralyzed", "condition:poisoned", "condition:prone", "condition:restrained"] },
  ],
});

export const srd51StarterMonsters: readonly MonsterDefinition[] = [
  goblin,
  wolf,
  bugbear,
  giantWolfSpider,
  kobold,
  giantRat,
  zombie,
  orc,
  skeleton,
  hobgoblin,
  ogre,
  specter,
];
