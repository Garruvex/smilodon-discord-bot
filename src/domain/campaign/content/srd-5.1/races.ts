import { defineRace, type RaceDefinition } from "../../rules/content-definitions.js";

// SRD 5.1's playable races (2014 rules). Speed and ability score increases
// are exact; traits reuse the shared Trait vocabulary where a race's trait
// is something the engine already implements (mainly damage resistance) and
// are left out, with a comment, where it is not — the same "not modeled"
// convention the monster roster (starter-monsters.ts) already uses.
const source = "SRD 5.1";

export const human = defineRace({
  id: "race:human",
  source,
  speed: 30,
  abilityScoreIncrease: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
  traits: [],
});

// Not modeled: Darkvision (the engine has no vision/lighting system), Keen
// Senses (a Perception skill proficiency; skill choices are the class's, not
// a race's, in this build), Fey Ancestry (advantage on saves against being
// charmed, and immunity to magical sleep — the engine has no per-condition
// save-advantage mechanic), Trance (no long-rest-length rule to shorten).
export const elf = defineRace({
  id: "race:elf",
  source,
  speed: 30,
  abilityScoreIncrease: { dex: 2 },
  traits: [],
});

// Not modeled: Darkvision, Dwarven Combat Training and Tool Proficiency
// (heroes are already proficient with whatever they carry), Stonecunning.
export const dwarf = defineRace({
  id: "race:dwarf",
  source,
  speed: 25,
  abilityScoreIncrease: { con: 2 },
  traits: [{ kind: "damageResistance", damageTypes: ["poison"] }],
});

// Not modeled: Lucky (reroll a natural 1 on the d20), Brave (advantage
// against being frightened — the same save-advantage gap as Elf's Fey
// Ancestry), Halfling Nimbleness (moving through a larger creature's space;
// the engine has no grid).
export const halfling = defineRace({
  id: "race:halfling",
  source,
  speed: 25,
  abilityScoreIncrease: { dex: 2 },
  traits: [],
});

// SRD 5.1 offers a choice of Draconic Ancestry, each with its own damage
// type; only one (the Red line, fire) is modeled here, the same "pick one
// and document it" liberty Wild Shape takes with the Wolf. The breath weapon
// itself is not modeled (no area-effect action shape yet).
export const dragonborn = defineRace({
  id: "race:dragonborn",
  source,
  speed: 30,
  abilityScoreIncrease: { str: 2, cha: 1 },
  traits: [{ kind: "damageResistance", damageTypes: ["fire"] }],
});

// Not modeled: Darkvision, Gnome Cunning (advantage on Intelligence, Wisdom,
// and Charisma saves against magic — the engine's saves have no "against
// magic" qualifier to hook it to).
export const gnome = defineRace({
  id: "race:gnome",
  source,
  speed: 25,
  abilityScoreIncrease: { int: 2 },
  traits: [],
});

// SRD 5.1's +1 to two abilities of the player's choice is fixed here to
// Dexterity and Constitution, the same "pick a default and document it"
// liberty the class roster's kits already take. Not modeled: Darkvision, Fey
// Ancestry (see Elf), Skill Versatility (extra skill proficiencies — the
// builder's skill count is the class's, not adjustable per race yet).
export const halfElf = defineRace({
  id: "race:half-elf",
  source,
  speed: 30,
  abilityScoreIncrease: { cha: 2, dex: 1, con: 1 },
  traits: [],
});

// Not modeled: Darkvision, Relentless Endurance (drop to 1 HP instead of 0
// once per long rest — the same shape of omission as Zombie's Undead
// Fortitude in the monster roster), Savage Attacks (an extra weapon damage
// die on a critical hit).
export const halfOrc = defineRace({
  id: "race:half-orc",
  source,
  speed: 30,
  abilityScoreIncrease: { str: 2, con: 1 },
  traits: [],
});

// Not modeled: Darkvision, Infernal Legacy (a bonus cantrip, and spells at
// higher levels, outside the class's own spell list — a character's spells
// are entirely the class's here).
export const tiefling = defineRace({
  id: "race:tiefling",
  source,
  speed: 30,
  abilityScoreIncrease: { cha: 2, int: 1 },
  traits: [{ kind: "damageResistance", damageTypes: ["fire"] }],
});

export const srd51Races: readonly RaceDefinition[] = [human, elf, dwarf, halfling, dragonborn, gnome, halfElf, halfOrc, tiefling];
