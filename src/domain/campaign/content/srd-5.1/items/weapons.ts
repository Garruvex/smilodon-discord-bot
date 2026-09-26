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
export const bite = defineWeapon({ id: "item:bite", source, damage: dice(1, 4), damageType: "piercing", range: melee, finesse: false, natural: true });

export const srd51Weapons: readonly WeaponDefinition[] = [longsword, shortsword, scimitar, mace, morningstar, shortbow, bite];
