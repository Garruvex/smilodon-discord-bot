import { dice, flat } from "../../../dice/dice-expression.js";
import { defineSpell, type SpellDefinition } from "../../../rules/content-definitions.js";
import type { Ability, DamageType } from "../../../rules/effects.js";

// Class and racial abilities that act like a spell: they target creatures, may call for a saving throw,
// and are limited by uses rather than slots. A `featureSpell` trait (rules/traits.ts) puts one on a hero's
// turn menu; none of them is on a class spell list.
const source = "SRD 5.1";

// A d6, becoming a d8 at level 5, a d10 at 10 and a d12 at 15.
const inspirationDie = (level: number): 6 | 8 | 10 | 12 => (level >= 15 ? 12 : level >= 10 ? 10 : level >= 5 ? 8 : 6);

export const bardicInspiration = defineSpell({
  id: "spell:bardic-inspiration",
  source,
  level: 0,
  castingTime: "bonus-action",
  range: { kind: "feet", feet: 60 },
  targeting: { relation: "ally-or-self", count: 1 },
  concentration: false,
  plan: ({ casterLevel }) => ({
    check: null,
    onLand: [{ kind: "bonusDie", target: "target", die: dice(1, inspirationDie(casterLevel)), appliesTo: ["attack", "save"], duration: { kind: "rounds", count: 10 } }],
    onAvoid: [],
  }),
});

// The SRD's pool of 5 hit points per level, spent in one healing.
export const layOnHands = defineSpell({
  id: "spell:lay-on-hands",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "touch" },
  targeting: { relation: "ally-or-self", count: 1 },
  concentration: false,
  plan: ({ casterLevel }) => ({ check: null, onLand: [{ kind: "heal", target: "target", amount: flat(casterLevel * 5) }], onAvoid: [] }),
});

// Dragonborn ancestries: the color, its damage type, the save it calls for, and whether the breath is a line (30 ft) or a cone (15 ft).
export const breathAncestries: readonly (readonly [string, DamageType, Ability, number])[] = [
  ["black", "acid", "dex", 30],
  ["blue", "lightning", "dex", 30],
  ["brass", "fire", "dex", 30],
  ["bronze", "lightning", "dex", 30],
  ["copper", "acid", "dex", 30],
  ["gold", "fire", "dex", 15],
  ["green", "poison", "con", 15],
  ["red", "fire", "dex", 15],
  ["silver", "cold", "con", 15],
  ["white", "cold", "con", 15],
];

// 2d6 at level 1, 3d6 at 6, 4d6 at 11 and 5d6 at 16.
const breathDice = (level: number): number => (level >= 16 ? 5 : level >= 11 ? 4 : level >= 6 ? 3 : 2);

export const breathWeaponId = (color: string): `spell:breath-weapon-${string}` => `spell:breath-weapon-${color}`;

export const breathWeapons: readonly SpellDefinition[] = breathAncestries.map(([color, damageType, ability, feet]) =>
  defineSpell({
    id: breathWeaponId(color),
    source,
    level: 0,
    castingTime: "action",
    range: { kind: "feet", feet },
    targeting: { relation: "enemy", count: 6 },
    concentration: false,
    plan: ({ casterLevel }) => ({
      check: { kind: "savingThrow", ability },
      onLand: [{ kind: "damage", target: "target", amount: dice(breathDice(casterLevel), 6), damageType }],
      onAvoid: [{ kind: "damage", target: "target", amount: dice(breathDice(casterLevel), 6), damageType, halfOfLand: true }],
    }),
  }),
);

export const srd51ClassAbilitySpells: readonly SpellDefinition[] = [bardicInspiration, layOnHands, ...breathWeapons];
