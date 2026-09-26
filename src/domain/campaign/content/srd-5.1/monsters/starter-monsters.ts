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
});

// The starter adventure's leader, Skarn. Brute is already part of the
// morningstar's 2d8 melee damage. Not modeled: Surprise Attack (the
// engine has no surprise rules yet).
export const bugbear = defineMonster({
  id: "monster:bugbear",
  source,
  armorClass: 16,
  maxHp: 27,
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
});

export const srd51StarterMonsters: readonly MonsterDefinition[] = [goblin, wolf, bugbear, giantWolfSpider];
