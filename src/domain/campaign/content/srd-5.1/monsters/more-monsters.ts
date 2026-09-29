import { dice, plus } from "../../../dice/dice-expression.js";
import { defineMonster, type MonsterDefinition } from "../../../rules/content-definitions.js";

// A wider roster for longer adventures (SRD 5.1, Monsters), challenge 1/8 to 3.
// Attack bonuses and damage are the stat block's. A stat block with Multiattack
// is played as its one strongest attack, so those monsters are weaker than
// written. Not modeled, across the roster: damage that a rider adds on top of a
// hit (a poison's extra dice; only its condition is applied), Relentless,
// Rampage, Keen Smell and Hold Breath.
const source = "SRD 5.1";

export const bandit = defineMonster({
  id: "monster:bandit",
  source,
  armorClass: 12,
  maxHp: 11,
  xp: 25,
  speed: 30,
  abilityScores: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  attacks: [
    { weapon: "item:scimitar", toHit: 3, damage: plus(dice(1, 6), 1) },
    { weapon: "item:light-crossbow", toHit: 3, damage: plus(dice(1, 8), 1) },
  ],
  tactic: "skirmisher",
  traits: [],
});

// Multiattack (two scimitar strikes and a dagger) and Parry are not modeled.
export const banditCaptain = defineMonster({
  id: "monster:bandit-captain",
  source,
  armorClass: 15,
  maxHp: 65,
  xp: 450,
  speed: 30,
  abilityScores: { str: 15, dex: 16, con: 14, int: 14, wis: 11, cha: 14 },
  attacks: [{ weapon: "item:scimitar", toHit: 5, damage: plus(dice(1, 6), 3) }],
  tactic: "brute",
  traits: [],
});

export const cultist = defineMonster({
  id: "monster:cultist",
  source,
  armorClass: 12,
  maxHp: 9,
  xp: 25,
  speed: 30,
  abilityScores: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 },
  attacks: [{ weapon: "item:scimitar", toHit: 3, damage: plus(dice(1, 6), 1) }],
  tactic: "brute",
  traits: [],
});

export const guard = defineMonster({
  id: "monster:guard",
  source,
  armorClass: 16,
  maxHp: 11,
  xp: 25,
  speed: 30,
  abilityScores: { str: 13, dex: 12, con: 12, int: 10, wis: 11, cha: 10 },
  attacks: [{ weapon: "item:spear", toHit: 3, damage: plus(dice(1, 6), 1) }],
  tactic: "brute",
  traits: [],
});

export const acolyte = defineMonster({
  id: "monster:acolyte",
  source,
  armorClass: 10,
  maxHp: 9,
  xp: 50,
  speed: 30,
  abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 14, cha: 11 },
  attacks: [{ weapon: "item:club", toHit: 2, damage: dice(1, 4) }],
  tactic: "brute",
  traits: [],
});

export const boar = defineMonster({
  id: "monster:boar",
  source,
  armorClass: 11,
  maxHp: 11,
  xp: 50,
  speed: 40,
  abilityScores: { str: 13, dex: 11, con: 12, int: 2, wis: 9, cha: 5 },
  attacks: [{ weapon: "item:tusk", toHit: 3, damage: plus(dice(1, 6), 1) }],
  tactic: "brute",
  traits: [],
});

export const giantBoar = defineMonster({
  id: "monster:giant-boar",
  source,
  armorClass: 12,
  maxHp: 42,
  xp: 450,
  speed: 40,
  abilityScores: { str: 17, dex: 10, con: 16, int: 2, wis: 7, cha: 5 },
  attacks: [{ weapon: "item:tusk", toHit: 5, damage: plus(dice(2, 6), 3) }],
  tactic: "brute",
  traits: [],
});

// Flies at 60 feet; the engine tracks one speed, so that is it.
export const giantBat = defineMonster({
  id: "monster:giant-bat",
  source,
  armorClass: 13,
  maxHp: 22,
  xp: 50,
  speed: 60,
  abilityScores: { str: 15, dex: 16, con: 11, int: 2, wis: 12, cha: 6 },
  attacks: [{ weapon: "item:bite", toHit: 4, damage: plus(dice(1, 6), 2) }],
  tactic: "skirmisher",
  traits: [],
});

export const giantPoisonousSnake = defineMonster({
  id: "monster:giant-poisonous-snake",
  source,
  armorClass: 14,
  maxHp: 11,
  xp: 50,
  speed: 30,
  abilityScores: { str: 10, dex: 18, con: 13, int: 2, wis: 10, cha: 3 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 6,
      damage: dice(1, 4),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "con", dc: 11, condition: "condition:poisoned" }],
    },
  ],
  tactic: "brute",
  traits: [],
});

// Multiattack (bite and claws) is played as the claws.
export const blackBear = defineMonster({
  id: "monster:black-bear",
  source,
  armorClass: 11,
  maxHp: 19,
  xp: 100,
  speed: 40,
  abilityScores: { str: 15, dex: 10, con: 14, int: 2, wis: 12, cha: 7 },
  attacks: [{ weapon: "item:claw", toHit: 3, damage: plus(dice(2, 4), 2) }],
  tactic: "brute",
  traits: [],
});

export const brownBear = defineMonster({
  id: "monster:brown-bear",
  source,
  armorClass: 11,
  maxHp: 34,
  xp: 200,
  speed: 40,
  abilityScores: { str: 19, dex: 10, con: 16, int: 2, wis: 13, cha: 7 },
  attacks: [{ weapon: "item:claw", toHit: 6, damage: plus(dice(2, 4), 4) }],
  tactic: "brute",
  traits: [],
});

// The grapple is an escape-DC grapple in the book; here a Strength save stands in for it.
export const crocodile = defineMonster({
  id: "monster:crocodile",
  source,
  armorClass: 12,
  maxHp: 19,
  xp: 100,
  speed: 20,
  abilityScores: { str: 15, dex: 10, con: 13, int: 2, wis: 10, cha: 5 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 4,
      damage: plus(dice(1, 10), 2),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "str", dc: 12, condition: "condition:grappled" }],
    },
  ],
  tactic: "brute",
  traits: [],
});

export const gnoll = defineMonster({
  id: "monster:gnoll",
  source,
  armorClass: 15,
  maxHp: 22,
  xp: 100,
  speed: 30,
  abilityScores: { str: 14, dex: 12, con: 11, int: 6, wis: 10, cha: 7 },
  attacks: [
    { weapon: "item:spear", toHit: 4, damage: plus(dice(1, 6), 2) },
    { weapon: "item:longbow", toHit: 3, damage: plus(dice(1, 8), 1) },
  ],
  tactic: "brute",
  traits: [],
});

// Multiattack (bite and a weapon) is played as one weapon attack.
export const lizardfolk = defineMonster({
  id: "monster:lizardfolk",
  source,
  armorClass: 15,
  maxHp: 22,
  xp: 100,
  speed: 30,
  abilityScores: { str: 15, dex: 10, con: 13, int: 7, wis: 12, cha: 7 },
  attacks: [
    { weapon: "item:mace", toHit: 4, damage: plus(dice(1, 6), 2) },
    { weapon: "item:javelin", toHit: 4, damage: plus(dice(1, 6), 2), range: { kind: "ranged", normal: 30, long: 120 } },
  ],
  tactic: "brute",
  traits: [],
});

// Web and Web Walker are not modeled, and the bite's extra 2d8 poison damage
// is left out; only the Poisoned condition on a failed save is applied.
export const giantSpider = defineMonster({
  id: "monster:giant-spider",
  source,
  armorClass: 14,
  maxHp: 26,
  xp: 200,
  speed: 30,
  abilityScores: { str: 14, dex: 16, con: 12, int: 2, wis: 11, cha: 4 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 5,
      damage: plus(dice(1, 8), 3),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "con", dc: 11, condition: "condition:poisoned" }],
    },
  ],
  tactic: "brute",
  traits: [],
});

export const direWolf = defineMonster({
  id: "monster:dire-wolf",
  source,
  armorClass: 14,
  maxHp: 37,
  xp: 200,
  speed: 50,
  abilityScores: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 5,
      damage: plus(dice(2, 6), 3),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "str", dc: 13, condition: "condition:prone" }],
    },
  ],
  tactic: "brute",
  traits: [{ kind: "packTactics" }],
});

// The claws paralyze on a failed Constitution save, as written (the book
// exempts elves; the engine does not know a target's race here).
export const ghoul = defineMonster({
  id: "monster:ghoul",
  source,
  armorClass: 12,
  maxHp: 22,
  xp: 200,
  speed: 30,
  abilityScores: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 },
  attacks: [
    {
      weapon: "item:claw",
      toHit: 4,
      damage: plus(dice(2, 4), 2),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "con", dc: 10, condition: "condition:paralyzed" }],
    },
  ],
  tactic: "brute",
  traits: [{ kind: "damageImmunity", damageTypes: ["poison"] }, { kind: "conditionImmunity", conditions: ["condition:charmed", "condition:poisoned"] }],
});

// Multiattack (beak and claws) is played as the claws.
export const owlbear = defineMonster({
  id: "monster:owlbear",
  source,
  armorClass: 13,
  maxHp: 59,
  xp: 700,
  speed: 40,
  abilityScores: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
  attacks: [{ weapon: "item:claw", toHit: 7, damage: plus(dice(2, 8), 5) }],
  tactic: "brute",
  traits: [],
});

// Wilted-forest creatures and a hag, for the farm-and-forest style of adventure.
export const twigBlight = defineMonster({
  id: "monster:twig-blight",
  source,
  armorClass: 13,
  maxHp: 4,
  xp: 25,
  speed: 20,
  abilityScores: { str: 6, dex: 13, con: 12, int: 3, wis: 8, cha: 3 },
  attacks: [{ weapon: "item:claw", toHit: 3, damage: plus(dice(1, 4), 1) }],
  tactic: "brute",
  traits: [{ kind: "conditionImmunity", conditions: ["condition:blinded"] }],
});

// The needles (a ranged attack) are not modeled; it fights with its claws.
export const needleBlight = defineMonster({
  id: "monster:needle-blight",
  source,
  armorClass: 12,
  maxHp: 11,
  xp: 50,
  speed: 30,
  abilityScores: { str: 12, dex: 12, con: 13, int: 4, wis: 8, cha: 3 },
  attacks: [{ weapon: "item:claw", toHit: 3, damage: plus(dice(2, 6), 1) }],
  tactic: "brute",
  traits: [{ kind: "conditionImmunity", conditions: ["condition:blinded"] }],
});

// The poison's extra damage is left out; only Poisoned on a failed save applies.
export const giantCentipede = defineMonster({
  id: "monster:giant-centipede",
  source,
  armorClass: 13,
  maxHp: 4,
  xp: 50,
  speed: 30,
  abilityScores: { str: 5, dex: 14, con: 12, int: 1, wis: 7, cha: 3 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 4,
      damage: plus(dice(1, 4), 2),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "con", dc: 11, condition: "condition:poisoned" }],
    },
  ],
  tactic: "brute",
  traits: [],
});

// The bite and the constricting coil are one attack here: the bite's damage, and a
// Strength save against being grappled.
export const giantConstrictorSnake = defineMonster({
  id: "monster:giant-constrictor-snake",
  source,
  armorClass: 12,
  maxHp: 60,
  xp: 450,
  speed: 30,
  abilityScores: { str: 19, dex: 14, con: 12, int: 1, wis: 10, cha: 3 },
  attacks: [
    {
      weapon: "item:bite",
      toHit: 6,
      damage: plus(dice(2, 6), 4),
      onHit: [{ kind: "conditionUnlessSave", target: "target", ability: "str", dc: 16, condition: "condition:grappled" }],
    },
  ],
  tactic: "brute",
  traits: [],
});

// Not modeled: Illusory Appearance, Invisible Passage, Mimicry, Amphibious.
export const greenHag = defineMonster({
  id: "monster:green-hag",
  source,
  armorClass: 17,
  maxHp: 82,
  xp: 700,
  speed: 30,
  abilityScores: { str: 18, dex: 12, con: 16, int: 13, wis: 14, cha: 14 },
  attacks: [{ weapon: "item:claw", toHit: 6, damage: plus(dice(2, 8), 4) }],
  tactic: "brute",
  traits: [],
});

export const srd51MoreMonsters: readonly MonsterDefinition[] = [
  bandit,
  banditCaptain,
  cultist,
  guard,
  acolyte,
  boar,
  giantBoar,
  giantBat,
  giantPoisonousSnake,
  blackBear,
  brownBear,
  crocodile,
  gnoll,
  lizardfolk,
  giantSpider,
  direWolf,
  ghoul,
  owlbear,
  twigBlight,
  needleBlight,
  giantCentipede,
  giantConstrictorSnake,
  greenHag,
];
