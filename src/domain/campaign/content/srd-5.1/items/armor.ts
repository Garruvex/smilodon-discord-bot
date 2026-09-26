import { defineArmor, defineShield, type ItemDefinition } from "../../../rules/content-definitions.js";

// The milestone 0 heroes' armor (SRD 5.1, Equipment: Armor and Shields).
const source = "SRD 5.1";

export const leatherArmor = defineArmor({
  id: "item:leather-armor",
  source,
  category: "light",
  baseArmorClass: 11,
  dexterityCap: null,
  stealthDisadvantage: false,
  strengthRequirement: null,
});

export const chainMail = defineArmor({
  id: "item:chain-mail",
  source,
  category: "heavy",
  baseArmorClass: 16,
  dexterityCap: 0,
  stealthDisadvantage: true,
  strengthRequirement: 13,
});

export const shield = defineShield({ id: "item:shield", source, armorClassBonus: 2 });

export const srd51Armor: readonly ItemDefinition[] = [leatherArmor, chainMail, shield];
