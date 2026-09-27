import { dice } from "../../../dice/dice-expression.js";
import { defineWeapon, type WeaponDefinition } from "../../../rules/content-definitions.js";

// The milestone 0 weapons (SRD 5.1, Equipment). Thrown and versatile use
// arrive with the rules that need them; these entries cover the heroes'
// starting weapons and the starter monsters' attacks.
const source = "SRD 5.1";
const melee = { kind: "melee" } as const;

export const longsword = defineWeapon({ id: "item:longsword", source, damage: dice(1, 8), damageType: "slashing", range: melee, finesse: false, natural: false });
export const shortsword = defineWeapon({ id: "item:shortsword", source, damage: dice(1, 6), damageType: "piercing", range: melee, finesse: true, natural: false });
export const scimitar = defineWeapon({ id: "item:scimitar", source, damage: dice(1, 6), damageType: "slashing", range: melee, finesse: true, natural: false });
export const mace = defineWeapon({ id: "item:mace", source, damage: dice(1, 6), damageType: "bludgeoning", range: melee, finesse: false, natural: false });
export const morningstar = defineWeapon({ id: "item:morningstar", source, damage: dice(1, 8), damageType: "piercing", range: melee, finesse: false, natural: false });
export const shortbow = defineWeapon({
  id: "item:shortbow",
  source,
  damage: dice(1, 6),
  damageType: "piercing",
  range: { kind: "ranged", normal: 80, long: 320 },
  finesse: false,
  natural: false,
});
export const javelin = defineWeapon({
  id: "item:javelin",
  source,
  damage: dice(1, 6),
  damageType: "piercing",
  // Thrown 30/120; used here only as a thrown weapon (monster stat blocks).
  range: { kind: "ranged", normal: 30, long: 120 },
  finesse: false,
  natural: false,
});
export const bite = defineWeapon({ id: "item:bite", source, damage: dice(1, 4), damageType: "piercing", range: melee, finesse: false, natural: true });

// Added for the full SRD class roster (step 7): one new melee weapon per
// class that the existing six don't already cover.
export const greataxe = defineWeapon({ id: "item:greataxe", source, damage: dice(1, 12), damageType: "slashing", range: melee, finesse: false, natural: false });
export const quarterstaff = defineWeapon({ id: "item:quarterstaff", source, damage: dice(1, 6), damageType: "bludgeoning", range: melee, finesse: false, natural: false });
export const rapier = defineWeapon({ id: "item:rapier", source, damage: dice(1, 8), damageType: "piercing", range: melee, finesse: true, natural: false });
export const dagger = defineWeapon({ id: "item:dagger", source, damage: dice(1, 4), damageType: "piercing", range: melee, finesse: true, natural: false });
export const longbow = defineWeapon({
  id: "item:longbow",
  source,
  damage: dice(1, 8),
  damageType: "piercing",
  range: { kind: "ranged", normal: 150, long: 600 },
  finesse: false,
  natural: false,
});

// Added for engine-robustness pass (step 8): a monster's natural slam attack (zombie).
export const slam = defineWeapon({ id: "item:slam", source, damage: dice(1, 6), damageType: "bludgeoning", range: melee, finesse: false, natural: true });

export const srd51Weapons: readonly WeaponDefinition[] = [
  longsword,
  shortsword,
  scimitar,
  mace,
  morningstar,
  shortbow,
  javelin,
  bite,
  greataxe,
  quarterstaff,
  rapier,
  dagger,
  longbow,
  slam,
];
