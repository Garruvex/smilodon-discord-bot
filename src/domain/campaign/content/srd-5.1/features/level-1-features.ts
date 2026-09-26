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
  traits: [{ kind: "sneakAttack", dice: dice(1, 6) }],
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

export const srd51Level1Features: readonly FeatureDefinition[] = [fightingStyleDueling, secondWind, sneakAttack, thievesCant, discipleOfLife];
