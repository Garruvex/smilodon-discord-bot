import { dice } from "../../../dice/dice-expression.js";
import { defineWeapon, type WeaponDefinition } from "../../../rules/content-definitions.js";

// The milestone 0 weapons (SRD 5.1, Equipment). Thrown and versatile use
// arrive with the rules that need them; these entries cover the heroes'
// starting weapons and the starter monsters' attacks.
const source = "SRD 5.1";
const melee = { kind: "melee" } as const;

export const longsword = defineWeapon({ id: "item:longsword", source, damage: dice(1, 8), damageType: "slashing", range: melee, finesse: false, natural: false });
export const shortsword = defineWeapon({ id: "item:shortsword", source, light: true, damage: dice(1, 6), damageType: "piercing", range: melee, finesse: true, natural: false });
export const scimitar = defineWeapon({ id: "item:scimitar", source, light: true, damage: dice(1, 6), damageType: "slashing", range: melee, finesse: true, natural: false });
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
export const scorchingSphere = defineWeapon({ id: "item:scorching-sphere", source, damage: dice(2, 6), damageType: "fire", range: melee, finesse: false, natural: true });
// Pact of the Blade: the weapon the warlock calls into their hand. Always at hand in a fight (the bonus action to summon it is not asked for).
export const pactBlade = defineWeapon({ id: "item:pact-blade", source, damage: dice(1, 8), damageType: "slashing", range: melee, finesse: true, natural: false });
export const spectralWeapon = defineWeapon({ id: "item:spectral-weapon", source, damage: dice(1, 8), damageType: "force", range: melee, finesse: false, natural: true });

// Added for the full SRD class roster (step 7): one new melee weapon per
// class that the existing six don't already cover.
export const greataxe = defineWeapon({ id: "item:greataxe", source, damage: dice(1, 12), damageType: "slashing", range: melee, finesse: false, natural: false });
export const quarterstaff = defineWeapon({ id: "item:quarterstaff", source, damage: dice(1, 6), damageType: "bludgeoning", range: melee, finesse: false, natural: false });
export const rapier = defineWeapon({ id: "item:rapier", source, damage: dice(1, 8), damageType: "piercing", range: melee, finesse: true, natural: false });
export const dagger = defineWeapon({ id: "item:dagger", source, light: true, damage: dice(1, 4), damageType: "piercing", range: melee, finesse: true, natural: false });
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

// Added for engine-robustness pass (step 14): more monster attacks.
export const greatclub = defineWeapon({ id: "item:greatclub", source, damage: dice(2, 8), damageType: "bludgeoning", range: melee, finesse: false, natural: false });
export const lifeDrain = defineWeapon({ id: "item:life-drain", source, damage: dice(3, 6), damageType: "necrotic", range: melee, finesse: false, natural: true });

// Added with the wider monster roster: what those stat blocks swing, shoot and claw with.
export const club = defineWeapon({ id: "item:club", source, light: true, damage: dice(1, 4), damageType: "bludgeoning", range: melee, finesse: false, natural: false });
export const spear = defineWeapon({ id: "item:spear", source, damage: dice(1, 6), damageType: "piercing", range: melee, finesse: false, natural: false });
export const lightCrossbow = defineWeapon({
  id: "item:light-crossbow",
  source,
  damage: dice(1, 8),
  damageType: "piercing",
  range: { kind: "ranged", normal: 80, long: 320 },
  finesse: false,
  natural: false,
});
export const claw = defineWeapon({ id: "item:claw", source, damage: dice(1, 4), damageType: "slashing", range: melee, finesse: false, natural: true });
export const tusk = defineWeapon({ id: "item:tusk", source, damage: dice(1, 6), damageType: "slashing", range: melee, finesse: false, natural: true });

export const srd51Weapons: readonly WeaponDefinition[] = [
  longsword,
  shortsword,
  scimitar,
  mace,
  morningstar,
  shortbow,
  javelin,
  bite,
  spectralWeapon,
  pactBlade,
  scorchingSphere,
  greataxe,
  quarterstaff,
  rapier,
  dagger,
  longbow,
  slam,
  greatclub,
  lifeDrain,
  club,
  spear,
  lightCrossbow,
  claw,
  tusk,
];
