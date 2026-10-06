import { dice } from "../../../dice/dice-expression.js";
import { defineArmor, defineShield, defineWeapon, type ArmorDefinition, type ItemDefinition, type ShieldDefinition, type WeaponDefinition } from "../../../rules/content-definitions.js";
import type { ContentId } from "../../../rules/content-id.js";
import type { DamageType } from "../../../rules/effects.js";
import { srd51Armor } from "./armor.js";
import { srd51GeneratedItems } from "./srd-equipment.generated.js";
import { srd51Weapons } from "./weapons.js";

// Magic weapons, armor and shields. The SRD's +1, +2 and +3 versions are built here from every ordinary weapon,
// armor and shield, so a hero can carry a Longsword +1 or Plate Armor +2; the named weapons (items/srd-magic-items.generated.ts)
// start from one of these base weapons too.
const baseItems: readonly ItemDefinition[] = [...srd51Weapons, ...srd51Armor, ...srd51GeneratedItems];

const baseWeapons = baseItems.filter((item): item is WeaponDefinition => item.itemType === "weapon" && !item.natural);
const baseArmor = baseItems.filter((item): item is ArmorDefinition => item.itemType === "armor");
const baseShields = baseItems.filter((item): item is ShieldDefinition => item.itemType === "shield");

export interface EnchantedGear {
  readonly id: ContentId<"item">;
  readonly baseId: ContentId<"item">;
  readonly bonus: number;
}

const bonuses = [1, 2, 3] as const;
const plusId = (baseId: string, bonus: number): ContentId<"item"> => `${baseId}-plus-${bonus}` as ContentId<"item">;

const enchantedWeapons = baseWeapons.flatMap((base) => bonuses.map((bonus) => defineWeapon({ ...withoutKind(base), id: plusId(base.id, bonus), enchantment: bonus })));
const enchantedArmor = baseArmor.flatMap((base) => bonuses.map((bonus) => defineArmor({ ...withoutKind(base), id: plusId(base.id, bonus), baseArmorClass: base.baseArmorClass + bonus })));
const enchantedShields = baseShields.flatMap((base) => bonuses.map((bonus) => defineShield({ ...withoutKind(base), id: plusId(base.id, bonus), armorClassBonus: base.armorClassBonus + bonus })));

export const srd51EnchantedGear: readonly ItemDefinition[] = [...enchantedWeapons, ...enchantedArmor, ...enchantedShields];

// For naming them: each one's base item and bonus.
export const enchantedGearList: readonly EnchantedGear[] = [...baseWeapons, ...baseArmor, ...baseShields].flatMap((base) =>
  bonuses.map((bonus) => ({ id: plusId(base.id, bonus), baseId: base.id, bonus })),
);

function withoutKind<T extends { readonly kind: "item"; readonly itemType: string }>(definition: T): Omit<T, "kind" | "itemType"> {
  const { kind: _kind, itemType: _itemType, ...rest } = definition;
  return rest;
}

// A named magic weapon: a base weapon with a bonus and, sometimes, extra damage on a hit.
export function magicWeapon(options: {
  readonly id: string;
  readonly base: string;
  readonly enchantment?: number;
  readonly extra?: { readonly dice: string; readonly damageType: DamageType };
}): WeaponDefinition {
  const base = baseWeapons.find((weapon) => weapon.id === options.base);
  if (base === undefined) throw new Error(`Unknown base weapon ${options.base} for ${options.id}.`);
  const match = options.extra === undefined ? null : /^(\d+)d(\d+)$/.exec(options.extra.dice);
  const onHit =
    options.extra === undefined || match === null
      ? undefined
      : [{ kind: "damage" as const, target: "target" as const, amount: dice(Number(match[1]), Number(match[2]) as 4 | 6 | 8 | 10 | 12), damageType: options.extra.damageType }];
  return defineWeapon({
    ...withoutKind(base),
    id: options.id as ContentId<"item">,
    ...(options.enchantment === undefined ? {} : { enchantment: options.enchantment }),
    ...(onHit === undefined ? {} : { onHit }),
  });
}
