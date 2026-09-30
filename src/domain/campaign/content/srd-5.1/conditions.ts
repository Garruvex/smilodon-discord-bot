import { defineCondition, type ConditionDefinition } from "../../rules/content-definitions.js";

// The SRD 5.1 conditions the engine implements, each as data: which conditions
// it includes and what it does, from the modifier vocabulary. The rule queries
// (effects/effect-queries.ts) read these; nothing else names a condition.
//
// Simplifications, until the engine has line of sight and forced movement:
// frightened gives disadvantage on attack rolls whether or not the source of
// fear can be seen, and does not stop the creature moving closer to it;
// blinded does not affect ability checks that rely on sight.

const source = "SRD 5.1";

export const incapacitated = defineCondition({ id: "condition:incapacitated", source, includes: [], modifiers: [{ kind: "blocksActions" }] });

export const prone = defineCondition({
  id: "condition:prone",
  source,
  includes: [],
  // Attack rolls against it have advantage from within 5 feet and disadvantage from farther away.
  modifiers: [
    { kind: "ownAttacks", mode: "disadvantage" },
    { kind: "attacksAgainst", mode: "advantage", reach: "within5" },
    { kind: "attacksAgainst", mode: "disadvantage", reach: "beyond5" },
  ],
});

// A marker, not a hardship: the creature keeps its reaction for something it chooses, so the reactions that fire by themselves
// (Protection, Deflect Missiles, Cutting Words, Uncanny Dodge) hold back.
export const holdingReactions = defineCondition({ id: "condition:holding-reactions", source, includes: [], modifiers: [] });

export const frightened = defineCondition({ id: "condition:frightened", source, includes: [], modifiers: [{ kind: "ownAttacks", mode: "disadvantage" }] });
// Turned by Turn Undead: it flees, so it takes no actions and attacks poorly if forced to.
export const turned = defineCondition({ id: "condition:turned", source, includes: [frightened.id, incapacitated.id], modifiers: [] });
export const poisoned = defineCondition({ id: "condition:poisoned", source, includes: [], modifiers: [{ kind: "ownAttacks", mode: "disadvantage" }] });

export const unconscious = defineCondition({
  id: "condition:unconscious",
  source,
  includes: [incapacitated.id, prone.id],
  modifiers: [
    { kind: "attacksAgainst", mode: "advantage", reach: "any" },
    { kind: "autoFailSaves", abilities: ["str", "dex"] },
    { kind: "critsAgainst", reach: "within5" },
  ],
});

export const grappled = defineCondition({ id: "condition:grappled", source, includes: [], modifiers: [{ kind: "speedZero" }] });

export const restrained = defineCondition({
  id: "condition:restrained",
  source,
  includes: [],
  modifiers: [
    { kind: "speedZero" },
    { kind: "ownAttacks", mode: "disadvantage" },
    { kind: "attacksAgainst", mode: "advantage", reach: "any" },
    { kind: "saves", ability: "dex", mode: "disadvantage" },
  ],
});

export const blinded = defineCondition({
  id: "condition:blinded",
  source,
  includes: [],
  modifiers: [
    { kind: "ownAttacks", mode: "disadvantage" },
    { kind: "attacksAgainst", mode: "advantage", reach: "any" },
  ],
});

// Added for engine-robustness pass (step 8): conditions the existing modifier
// vocabulary already covers in full, so no new Modifier kind was needed.
export const paralyzed = defineCondition({
  id: "condition:paralyzed",
  source,
  includes: [incapacitated.id],
  modifiers: [
    { kind: "speedZero" },
    { kind: "attacksAgainst", mode: "advantage", reach: "any" },
    { kind: "autoFailSaves", abilities: ["str", "dex"] },
    { kind: "critsAgainst", reach: "within5" },
  ],
});

export const stunned = defineCondition({
  id: "condition:stunned",
  source,
  includes: [incapacitated.id],
  modifiers: [
    { kind: "speedZero" },
    { kind: "attacksAgainst", mode: "advantage", reach: "any" },
    { kind: "autoFailSaves", abilities: ["str", "dex"] },
  ],
});

// Taken by surprise at the start of a fight: no action, movement or reaction until the first turn is over. It is
// incapacitated with the speed at zero, and the fight ends it (encounter-start.ts) once the creature's first turn has passed.
export const surprised = defineCondition({ id: "condition:surprised", source, includes: [incapacitated.id], modifiers: [{ kind: "speedZero" }] });

// Cannot hear: no rule here reads hearing, so it changes nothing by itself (a spell that needs a listener is the Narrator's to judge).
export const deafened = defineCondition({ id: "condition:deafened", source, includes: [], modifiers: [] });

// Turned to stone: incapacitated and unable to move, hit automatically and failing Strength and Dexterity saves, and resistant to all
// damage. The SRD's immunity to poison and disease is not played.
export const petrified = defineCondition({
  id: "condition:petrified",
  source,
  includes: [incapacitated.id],
  modifiers: [
    { kind: "speedZero" },
    { kind: "attacksAgainst", mode: "advantage", reach: "any" },
    { kind: "autoFailSaves", abilities: ["str", "dex"] },
    { kind: "damageResistance", damageTypes: ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"] },
  ],
});

export const invisible = defineCondition({
  id: "condition:invisible",
  source,
  includes: [],
  modifiers: [
    { kind: "ownAttacks", mode: "advantage" },
    { kind: "attacksAgainst", mode: "disadvantage", reach: "any" },
  ],
});

// Simplified: only the "can't attack or target the charmer" half is modeled;
// the charmer's advantage on social checks is narrative (the engine has no
// social-check roll to add it to).
export const charmed = defineCondition({ id: "condition:charmed", source, includes: [], modifiers: [{ kind: "cannotTargetSource" }] });

export const srd51Conditions: readonly ConditionDefinition[] = [
  holdingReactions,
  incapacitated,
  prone,
  frightened,
  turned,
  poisoned,
  unconscious,
  grappled,
  restrained,
  blinded,
  paralyzed,
  stunned,
  surprised,
  deafened,
  petrified,
  invisible,
  charmed,
];
