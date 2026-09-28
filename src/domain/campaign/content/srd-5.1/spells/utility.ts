import { defineSpell, type SpellDefinition } from "../../../rules/content-definitions.js";

const source = "SRD 5.1";

// Utility spells: never cast in a fight (engine/utility-magic.ts's
// castRitualSpell is refused mid-combat, the same as talking to an NPC or
// visiting a shop), so their `plan` is a narrative no-op — nothing here ever
// reaches declareResolution. The Narrator is asked to describe what the
// spell reveals or does, grounded in the same scene and ledger context every
// other narration gets, never a new mechanical Effect. Detect Magic,
// Identify, and Comprehend Languages are all ritual-tagged in the SRD, so a
// hero who knows them casts for free; Mage Hand and Prestidigitation are
// cantrips, already free regardless of the tag.

export const mageHand = defineSpell({
  id: "spell:mage-hand",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "self", count: 1 },
  concentration: false,
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

export const prestidigitation = defineSpell({
  id: "spell:prestidigitation",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 10 },
  targeting: { relation: "self", count: 1 },
  concentration: false,
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

export const detectMagic = defineSpell({
  id: "spell:detect-magic",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "self" },
  targeting: { relation: "self", count: 1 },
  concentration: true,
  ritual: true,
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

export const identify = defineSpell({
  id: "spell:identify",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "touch" },
  targeting: { relation: "self", count: 1 },
  concentration: false,
  ritual: true,
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

export const comprehendLanguages = defineSpell({
  id: "spell:comprehend-languages",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "self" },
  targeting: { relation: "self", count: 1 },
  concentration: false,
  ritual: true,
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

export const srd51UtilitySpells: readonly SpellDefinition[] = [mageHand, prestidigitation, detectMagic, identify, comprehendLanguages];
