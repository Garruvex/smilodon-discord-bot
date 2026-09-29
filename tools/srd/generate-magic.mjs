// Generates the SRD 5.1 magic items from the open 5e-bits/5e-database JSON (MIT, SRD 5.1 only).
//
//   node tools/srd/generate-magic.mjs <folder holding MagicItems.json>
//
// Only names, rarity and attunement are taken from the data; the descriptions are not copied. What an item does
// in the engine is written here (the MECHANICS tables below), and anything not listed there is for the story.
// The +1/+2/+3 weapons, armor and shields are built from the base equipment in items/magic-gear.ts, not here.
// Chinese names come from tools/srd/zh-tw-magic-names.json.
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("Pass the folder that holds MagicItems.json.");
const items = JSON.parse(readFileSync(join(dataDir, "MagicItems.json"), "utf8"));
const zhNames = JSON.parse(readFileSync(join(here, "zh-tw-magic-names.json"), "utf8"));

const quote = (text) => JSON.stringify(text);
const ac = (amount) => `{ kind: "armorClassBonus", amount: ${amount} }`;
const saves = (amount) => `{ kind: "saveBonus", amount: ${amount} }`;
const score = (ability, value) => `{ kind: "abilityScore", ability: ${quote(ability)}, score: ${value} }`;
const resist = (type) => `{ kind: "damageResistance", damageTypes: [${quote(type)}] }`;
const magicAdvantage = `{ kind: "saveAdvantage", magic: true }`;

// Passive powers, applied while the item is carried.
const TRAITS = {
  "ring-of-protection": [ac(1), saves(1)],
  "cloak-of-protection": [ac(1), saves(1)],
  "ioun-stone-of-protection": [ac(1)],
  "stone-of-good-luck-luckstone": [saves(1)],
  "amulet-of-health": [score("con", 19)],
  "gauntlets-of-ogre-power": [score("str", 19)],
  "headband-of-intellect": [score("int", 19)],
  "belt-of-giant-strength-hill": [score("str", 21)],
  "belt-of-giant-strength-stone": [score("str", 23)],
  "belt-of-giant-strength-frost": [score("str", 23)],
  "belt-of-giant-strength-fire": [score("str", 25)],
  "belt-of-giant-strength-cloud": [score("str", 27)],
  "belt-of-giant-strength-storm": [score("str", 29)],
  "ring-of-warmth": [resist("cold")],
  "brooch-of-shielding": [resist("force")],
  "periapt-of-proof-against-poison": [`{ kind: "damageImmunity", damageTypes: ["poison"] }`],
  "mantle-of-spell-resistance": [magicAdvantage],
  "scarab-of-protection": [magicAdvantage],
  "ring-of-spell-turning": [magicAdvantage],
};
for (const type of ["acid", "cold", "fire", "force", "lightning", "necrotic", "poison", "psychic", "radiant", "thunder"]) TRAITS[`ring-of-resistance-${type}`] = [resist(type)];

// Named weapons: the base weapon, its bonus, and extra damage on a hit.
const WEAPONS = {
  "flame-tongue": ["longsword", 0, ["2d6", "fire"]],
  "frost-brand": ["longsword", 0, ["1d6", "cold"]],
  "sword-of-wounding": ["longsword", 0, ["1d6", "necrotic"]],
  "sun-blade": ["longsword", 2, ["1d8", "radiant"]],
  "berserker-axe": ["battleaxe", 1],
  "dagger-of-venom": ["dagger", 1],
  defender: ["longsword", 1],
  "holy-avenger": ["longsword", 3],
  "luck-blade": ["shortsword", 1],
  "mace-of-smiting": ["mace", 1],
  "mace-of-disruption": ["mace", 0],
  "mace-of-terror": ["mace", 0],
  "nine-lives-stealer": ["longsword", 2],
  "scimitar-of-speed": ["scimitar", 2],
  "sword-of-life-stealing": ["longsword", 0],
  "sword-of-sharpness": ["longsword", 0],
  "vorpal-sword": ["longsword", 3],
  "dragon-slayer": ["longsword", 1],
  "giant-slayer": ["longsword", 1],
  "hammer-of-thunderbolts": ["maul", 1],
  "dwarven-thrower": ["warhammer", 3],
  oathbow: ["longbow", 0],
  "javelin-of-lightning": ["javelin", 0],
  "trident-of-fish-command": ["trident", 0],
};

// Armor, worn instead of the base armor (the bonus is already in the number).
const ARMOR = {
  "elven-chain": { category: "medium", ac: 14, cap: 2, stealth: false, str: null },
  "dwarven-plate": { category: "heavy", ac: 20, cap: 0, stealth: true, str: null },
  "glamoured-studded-leather-armor": { category: "light", ac: 13, cap: null, stealth: false, str: null },
};

// Potions of healing, at the average of their dice.
const HEALING = { "potion-of-healing-greater": 14, "potion-of-healing-superior": 28, "potion-of-healing-supreme": 45 };

const rarity = (name) => name.toLowerCase();
const skipped = (item) =>
  item.variants.length > 0 || // a parent entry; its variants are kept instead
  /^(weapon|armor|ammunition)(-[123])?$/.test(item.index) || // built from the base equipment instead
  item.index === "potion-of-healing-common"; // the starter potion
const kept = items.filter((item) => !skipped(item));

const missing = kept.filter((item) => zhNames[item.index] === undefined).map((item) => item.index);
if (missing.length > 0) throw new Error(`No Chinese name for: ${missing.join(", ")}. Add them to tools/srd/zh-tw-magic-names.json.`);

const lines = kept.map((item) => {
  const id = quote(`item:${item.index}`);
  if (WEAPONS[item.index] !== undefined) {
    const [base, bonus, extra] = WEAPONS[item.index];
    const options = [`id: ${id}`, `base: ${quote(`item:${base}`)}`];
    if (bonus !== 0) options.push(`enchantment: ${bonus}`);
    if (extra !== undefined) options.push(`extra: { dice: ${quote(extra[0])}, damageType: ${quote(extra[1])} }`);
    return `  magicWeapon({ ${options.join(", ")} }),`;
  }
  if (ARMOR[item.index] !== undefined) {
    const a = ARMOR[item.index];
    return `  defineArmor({ id: ${id}, source, category: ${quote(a.category)}, baseArmorClass: ${a.ac}, dexterityCap: ${a.cap}, stealthDisadvantage: ${a.stealth}, strengthRequirement: ${a.str} }),`;
  }
  if (item.index === "animated-shield") return `  defineShield({ id: ${id}, source, armorClassBonus: 2 }),`;
  if (HEALING[item.index] !== undefined) return `  definePotion({ id: ${quote(`item:${item.index.replace("potion-of-healing-", "potion-of-") + "-healing"}`)}, source, healing: ${HEALING[item.index]} }),`;
  const attunement = /requires attunement/i.test(item.desc[0] ?? "");
  const traits = (TRAITS[item.index] ?? []).join(", ");
  return `  defineMagicItem({ id: ${id}, source, rarity: ${quote(rarity(item.rarity.name))}, attunement: ${attunement}, category: ${quote(item.equipment_category.name.toLowerCase())}, traits: [${traits}] }),`;
});

const idOf = (item) => {
  if (HEALING[item.index] !== undefined) return `item:${item.index.replace("potion-of-healing-", "potion-of-")}-healing`;
  return `item:${item.index}`;
};

const header = "// GENERATED by tools/srd/generate-magic.mjs from the 5e-bits SRD 5.1 database (MIT). Do not edit by hand; change the generator and run it again.";
const itemsFile = `${header}
import { defineArmor, defineMagicItem, definePotion, defineShield, type ItemDefinition } from "../../../rules/content-definitions.js";
import { magicWeapon } from "./magic-gear.js";

const source = "SRD 5.1";

export const srd51MagicItems: readonly ItemDefinition[] = [
${lines.join("\n")}
];
`;
const namesFile = (names, note) => `${header}
// ${note}
export const srd51MagicNames: Readonly<Record<string, string>> = {
${kept.map((item) => `  ${quote(idOf(item))}: ${quote(names(item))},`).join("\n")}
};
`;

const content = join(root, "src/domain/campaign/content/srd-5.1");
const glossary = join(root, "src/application/i18n/campaign/glossary");
writeFileSync(join(content, "items/srd-magic-items.generated.ts"), itemsFile);
writeFileSync(join(glossary, "en/srd-magic-names.ts"), namesFile((item) => item.name, "English names for the SRD 5.1 magic items."));
writeFileSync(join(glossary, "zh-TW/srd-magic-names.ts"), namesFile((item) => zhNames[item.index], "Traditional Chinese names for the SRD 5.1 magic items."));
process.stdout.write(`${kept.length} magic items written.
`);
