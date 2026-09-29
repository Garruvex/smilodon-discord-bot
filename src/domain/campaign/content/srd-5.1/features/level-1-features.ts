import { dice, plus } from "../../../dice/dice-expression.js";
import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Level 1 class features of the three preset heroes (SRD 5.1, Classes).
// Expertise lives in the character's skill proficiencies; Thieves' Cant has
// no combat rules and is listed for the hero card.
const source = "SRD 5.1";

export const fightingStyleDueling = defineFeature({
  id: "feature:fighting-style-dueling",
  source,
  traits: [{ kind: "meleeDamageBonus", amount: 2 }],
  action: null,
});

export const fightingStyleArchery = defineFeature({ id: "feature:fighting-style-archery", source, traits: [{ kind: "rangedAttackBonus", amount: 2 }], action: null });
export const fightingStyleDefense = defineFeature({ id: "feature:fighting-style-defense", source, traits: [{ kind: "armoredBonus", amount: 1 }], action: null });

export const secondWind = defineFeature({
  id: "feature:second-wind",
  source,
  traits: [],
  action: {
    cost: "bonusAction",
    uses: { count: 1, recharge: "shortRest" },
    plan: ({ level }) => ({ check: null, onLand: [{ kind: "heal", target: "self", amount: plus(dice(1, 10), level) }], onAvoid: [] }),
  },
});

export const sneakAttack = defineFeature({
  id: "feature:sneak-attack",
  source,
  traits: [{ kind: "sneakAttack" }],
  action: null,
});

export const thievesCant = defineFeature({ id: "feature:thieves-cant", source, traits: [], action: null });

// Life Domain.
export const discipleOfLife = defineFeature({
  id: "feature:disciple-of-life",
  source,
  traits: [{ kind: "healingBonus", flat: 2, perSpellLevel: 1 }],
  action: null,
});

// Added for the full SRD class roster (step 7). Lay on Hands is mechanical
// (it maps cleanly onto Second Wind's self-heal shape); the rest are
// narrative-only for now, same treatment as Thieves' Cant and Thaumaturgy —
// the hero card names them, but no rule reads them. Level 2+ content (Rage's
// damage resistance, Wild Shape, Pact Magic's invocations, and so on) is out
// of scope for the starter roster.
// Rage: a bonus action; for 10 rounds the barbarian resists weapon damage and adds to melee damage
// (+2, +3 from level 9, +4 from level 16), with more uses a day as the barbarian levels (SRD 5.1).
// Unarmored Defense (10 + Dexterity + Constitution with no armor) is carried here too, so every barbarian has it.
const rageUses = (level: number): number => (level >= 17 ? 6 : level >= 12 ? 5 : level >= 6 ? 4 : level >= 3 ? 3 : 2);
export const rage = defineFeature({
  id: "feature:rage",
  source,
  traits: [{ kind: "unarmoredDefense", ability: "con" }],
  action: {
    cost: "bonusAction",
    uses: { count: 2, perLevel: rageUses, recharge: "longRest" },
    plan: ({ level }) => ({
      check: null,
      onLand: [
        {
          kind: "applyModifiers",
          target: "self",
          modifiers: [
            { kind: "damageResistance", damageTypes: ["bludgeoning", "piercing", "slashing"] },
            { kind: "meleeDamageBonus", amount: level >= 16 ? 4 : level >= 9 ? 3 : 2 },
          ],
          duration: { kind: "rounds", count: 10 },
        },
      ],
      onAvoid: [],
    }),
  },
});
// Bardic Inspiration and Lay on Hands are spell-shaped abilities (spells/class-ability-spells.ts): cast on an ally from the turn menu.
export const bardicInspiration = defineFeature({
  id: "feature:bardic-inspiration",
  source,
  traits: [{ kind: "featureSpell", spell: "spell:bardic-inspiration", ability: "cha", uses: null, usesAbility: true, recharge: "longRest" }],
  action: null,
});
export const druidic = defineFeature({ id: "feature:druidic", source, traits: [], action: null });
// Unarmored Defense (10 + Dexterity + Wisdom with no armor) is carried here so every monk has it.
export const martialArts = defineFeature({ id: "feature:martial-arts", source, traits: [{ kind: "unarmoredDefense", ability: "wis" }], action: null });
export const divineSense = defineFeature({ id: "feature:divine-sense", source, traits: [], action: null });
export const favoredEnemy = defineFeature({ id: "feature:favored-enemy", source, traits: [], action: null });
export const naturalExplorer = defineFeature({ id: "feature:natural-explorer", source, traits: [], action: null });
// Draconic Bloodline: every sorcerer here is a red dragon's descendant, the
// same "pick one and document it" liberty the Dragonborn race and Wild
// Shape's Wolf already take. Draconic Resilience: the fire resistance is
// mechanical (the same Trait a monster or race carries); the SRD's +1 HP per
// level and unarmored AC bonus are not modeled.
export const draconicBloodline = defineFeature({ id: "feature:draconic-bloodline", source, traits: [{ kind: "damageResistance", damageTypes: ["fire"] }], action: null });
// The Fiend: narrative only. Dark One's Blessing (temporary HP on a kill)
// needs a temporary-HP mechanic the engine doesn't have yet.
export const fiendPatron = defineFeature({ id: "feature:fiend-patron", source, traits: [], action: null });
// Once a day, on a short rest: spell slots back, up to half the wizard's level in combined slot levels.
export const arcaneRecovery = defineFeature({
  id: "feature:arcane-recovery",
  source,
  traits: [{ kind: "slotRecovery", feature: "feature:arcane-recovery" }],
  action: null,
  resource: { count: 1, recharge: "longRest" },
});

// The SRD's pool of 5 hit points per level is spent in one healing, on the paladin or an ally.
export const layOnHands = defineFeature({
  id: "feature:lay-on-hands",
  source,
  traits: [{ kind: "featureSpell", spell: "spell:lay-on-hands", ability: "cha", uses: 1, recharge: "longRest" }],
  action: null,
});

export const srd51Level1Features: readonly FeatureDefinition[] = [
  fightingStyleDueling,
  fightingStyleArchery,
  fightingStyleDefense,
  secondWind,
  sneakAttack,
  thievesCant,
  discipleOfLife,
  rage,
  bardicInspiration,
  druidic,
  martialArts,
  divineSense,
  layOnHands,
  favoredEnemy,
  naturalExplorer,
  draconicBloodline,
  fiendPatron,
  arcaneRecovery,
];
