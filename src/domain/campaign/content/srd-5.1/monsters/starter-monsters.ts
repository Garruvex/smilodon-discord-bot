import { dice, plus } from "../../../dice/dice-expression.js";
import { defineMonster, type MonsterDefinition } from "../../../rules/content-definitions.js";

// The starter adventure's monsters (SRD 5.1, Monsters). Attack bonuses and
// damage are the stat block's. Traits the engine does not implement yet are
// listed per entry and join with the combat rules that need them; until
// then these monsters are slightly weaker than written.
const source = "SRD 5.1";

// Not yet implemented: Nimble Escape (Disengage or Hide as a bonus action).
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
  traits: [],
});

// Not yet implemented: the bite's DC 11 Strength save against being knocked prone.
export const wolf = defineMonster({
  id: "monster:wolf",
  source,
  armorClass: 13,
  maxHp: 11,
  speed: 40,
  abilityScores: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
  attacks: [{ weapon: "item:bite", toHit: 4, damage: plus(dice(2, 4), 2) }],
  tactic: "brute",
  traits: [{ kind: "packTactics" }],
});

// The starter adventure's leader, Skarn. Brute is already part of the
// morningstar's 2d8 damage. Not yet implemented: Javelin (thrown) and
// Surprise Attack.
export const bugbear = defineMonster({
  id: "monster:bugbear",
  source,
  armorClass: 16,
  maxHp: 27,
  speed: 30,
  abilityScores: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 },
  attacks: [{ weapon: "item:morningstar", toHit: 4, damage: plus(dice(2, 8), 2) }],
  tactic: "brute",
  traits: [],
});

export const srd51StarterMonsters: readonly MonsterDefinition[] = [goblin, wolf, bugbear];
