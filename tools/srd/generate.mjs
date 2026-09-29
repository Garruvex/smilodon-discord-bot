// Generates the bulk of the SRD 5.1 content (monsters, their natural weapons,
// weapons and armor) from the open 5e-bits/5e-database JSON (MIT, SRD 5.1 only).
//
//   node tools/srd/generate.mjs <folder holding Monsters.json and Equipment.json (the 5e-SRD-*.json files)>
//
// The JSON is not kept in the repository; only the generated TypeScript is.
// Anything already written by hand under content/srd-5.1 is left alone: its ID
// is skipped here. Chinese names come from tools/srd/zh-tw-names.json.
import process from "node:process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("Pass the folder that holds the SRD JSON files.");
const read = (name) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
const monsters = read("Monsters.json");
const equipment = read("Equipment.json");

const content = join(root, "src/domain/campaign/content/srd-5.1");
const handWritten = (folder) =>
  readdirSync(join(content, folder))
    .filter((file) => file.endsWith(".ts") && !file.includes(".generated."))
    .map((file) => readFileSync(join(content, folder, file), "utf8"))
    .join("\n");
const idsIn = (text, kind) => new Set([...text.matchAll(new RegExp(`id: "(${kind}:[a-z0-9-]+)"`, "g"))].map((match) => match[1]));
const knownMonsters = idsIn(handWritten("monsters"), "monster");
const knownItems = idsIn(handWritten("items"), "item");

const damageTypes = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const dieSizes = [4, 6, 8, 10, 12, 20, 100];
const conditionNames = { prone: "prone", poisoned: "poisoned", paralyzed: "paralyzed", stunned: "stunned", blinded: "blinded", restrained: "restrained", frightened: "frightened", charmed: "charmed", grappled: "grappled", incapacitated: "incapacitated", invisible: "invisible" };
const abilityCodes = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const camel = (text) => slug(text).replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
const quote = (text) => JSON.stringify(text);

// ------------------------------------------------------------------ dice
function diceCode(text) {
  const match = /^(\d+)d(\d+)\s*(?:([+-])\s*(\d+))?$/.exec(text.replace(/\s+/g, " ").trim());
  if (match !== null) {
    const [, count, sides, sign, amount] = match;
    if (!dieSizes.includes(Number(sides))) return null;
    const base = `dice(${count}, ${sides})`;
    return sign === undefined ? base : `plus(${base}, ${sign === "-" ? "-" : ""}${amount})`;
  }
  return /^\d+$/.test(text.trim()) ? `flat(${text.trim()})` : null;
}

// ------------------------------------------------------------- equipment
// The SRD lists these crossbows with the type second; the content names them the way they read.
const equipmentAlias = { "crossbow-light": "light-crossbow", "crossbow-hand": "hand-crossbow", "crossbow-heavy": "heavy-crossbow" };
const weaponIdOf = new Map(); // "scimitar" -> "item:scimitar" for weapons the SRD equipment defines
const weaponLines = [];
const itemNames = {};
const armorLines = [];
const equipmentIds = [];
for (const entry of equipment) {
  const index = equipmentAlias[entry.index] ?? entry.index;
  const id = `item:${index}`;
  const category = entry.equipment_category?.index;
  if (category === "weapon" && entry.damage !== undefined) {
    weaponIdOf.set(index, id);
    if (knownItems.has(id)) continue;
    const expression = diceCode(entry.damage.damage_dice);
    const type = entry.damage.damage_type.index;
    if (expression === null || !damageTypes.includes(type)) continue;
    const properties = (entry.properties ?? []).map((property) => property.index);
    const ranged = entry.weapon_range === "Ranged";
    const range = ranged ? `{ kind: "ranged", normal: ${entry.range.normal}, long: ${entry.range.long ?? entry.range.normal} }` : "melee";
    weaponLines.push(`export const ${camel(index)} = defineWeapon({ id: ${quote(id)}, source, damage: ${expression}, damageType: ${quote(type)}, range: ${range}, finesse: ${properties.includes("finesse")}, natural: false });`);
    equipmentIds.push(camel(index));
    itemNames[id] = entry.name;
  } else if (category === "armor" && !knownItems.has(id)) {
    if (entry.armor_category === "Shield") {
      armorLines.push(`export const ${camel(index)} = defineShield({ id: ${quote(id)}, source, armorClassBonus: ${entry.armor_class.base} });`);
    } else {
      const cap = !entry.armor_class.dex_bonus ? 0 : (entry.armor_class.max_bonus ?? null);
      armorLines.push(
        `export const ${camel(index)} = defineArmor({ id: ${quote(id)}, source, category: ${quote(entry.armor_category.toLowerCase())}, baseArmorClass: ${entry.armor_class.base}, dexterityCap: ${cap}, stealthDisadvantage: ${entry.stealth_disadvantage === true}, strengthRequirement: ${entry.str_minimum > 0 ? entry.str_minimum : null} });`,
      );
    }
    equipmentIds.push(camel(index));
    itemNames[id] = entry.name;
  }
}

// ---------------------------------------------------------- natural attacks
// The names that the hand-written content already defines, with the type they use.
const canonicalNatural = { bite: "piercing", claw: "slashing", tusk: "slashing", slam: "bludgeoning", "life-drain": "necrotic" };
const naturalById = new Map(); // id -> { name, type, ranged, normal, long }
function weaponFor(action, damageType) {
  const key = slug(action.name.replace(/\s*\(.*\)$/, ""));
  const real = weaponIdOf.get(key);
  if (real !== undefined) return real;
  const ranged = /Ranged (Weapon|Spell) Attack/.test(action.desc);
  const reach = /range (\d+)\/(\d+) ft/.exec(action.desc);
  let id = `item:${key}`;
  if (canonicalNatural[key] !== undefined && canonicalNatural[key] !== damageType) id = `item:${key}-${damageType}`;
  else if (knownItems.has(id)) return id;
  const existing = naturalById.get(id);
  if (existing !== undefined && existing.type !== damageType) id = `item:${key}-${damageType}`;
  if (!knownItems.has(id) && !naturalById.has(id)) {
    naturalById.set(id, { name: action.name, type: damageType, ranged: ranged && reach !== null, normal: reach === null ? 0 : Number(reach[1]), long: reach === null ? 0 : Number(reach[2]) });
  }
  return id;
}

// --------------------------------------------------------------- monsters
const monsterLines = [];
const monsterNames = {};
const monsterList = [];
function damageList(monster, action) {
  const parts = [];
  let type = null;
  for (const entry of action.damage ?? []) {
    const code = entry.damage_dice === undefined ? null : diceCode(entry.damage_dice);
    const kind = entry.damage_type?.index;
    if (code === null || !damageTypes.includes(kind)) continue;
    parts.push(code);
    type ??= kind;
  }
  return parts.length === 0 ? null : { code: parts.length === 1 ? parts[0] : `combine(${parts.join(", ")})`, type, multiple: parts.length > 1 };
}
function riderCode(action) {
  const save = /DC (\d+) (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw or (?:be |become |is |are )?(?:knocked )?(prone|poisoned|paralyzed|stunned|blinded|restrained|frightened|charmed|grappled)/.exec(action.desc);
  if (save !== null) return `{ kind: "conditionUnlessSave", target: "target", ability: ${quote(abilityCodes[save[2].toLowerCase()])}, dc: ${save[1]}, condition: "condition:${conditionNames[save[3]]}" }`;
  const grapple = /grappled \(escape DC (\d+)\)/.exec(action.desc);
  if (grapple !== null) return `{ kind: "conditionUnlessSave", target: "target", ability: "str", dc: ${grapple[1]}, condition: "condition:grappled" }`;
  return null;
}
const weaponQualifier = /nonmagical|non-magical|silvered|adamantine/i;
function damageTraits(monster, notes) {
  const traits = [];
  const typesIn = (text) => damageTypes.filter((type) => text.toLowerCase().includes(type));
  const weaponTypes = ["bludgeoning", "piercing", "slashing"];
  const immune = [];
  const resist = [];
  for (const line of monster.damage_immunities) {
    const types = typesIn(line);
    if (weaponQualifier.test(line)) {
      // Immune only to mundane weapons: with no magic weapons to fall back on, that would be unbeatable, so it resists them.
      resist.push(...types.filter((type) => weaponTypes.includes(type)));
      immune.push(...types.filter((type) => !weaponTypes.includes(type)));
      if (types.some((type) => weaponTypes.includes(type))) notes.push("Immunity to mundane weapons is played as resistance");
    } else immune.push(...types);
  }
  for (const line of monster.damage_resistances) resist.push(...typesIn(line));
  const vulnerable = monster.damage_vulnerabilities.flatMap((line) => typesIn(line));
  const unique = (list) => [...new Set(list)];
  if (unique(immune).length > 0) traits.push(`{ kind: "damageImmunity", damageTypes: [${unique(immune).map(quote).join(", ")}] }`);
  const resistOnly = unique(resist).filter((type) => !immune.includes(type));
  if (resistOnly.length > 0) traits.push(`{ kind: "damageResistance", damageTypes: [${resistOnly.map(quote).join(", ")}] }`);
  if (unique(vulnerable).length > 0) traits.push(`{ kind: "damageVulnerability", damageTypes: [${unique(vulnerable).map(quote).join(", ")}] }`);
  const conditions = monster.condition_immunities.map((entry) => entry.index).filter((index) => conditionNames[index] !== undefined);
  if (conditions.length > 0) traits.push(`{ kind: "conditionImmunity", conditions: [${conditions.map((condition) => quote(`condition:${condition}`)).join(", ")}] }`);
  return traits;
}

// The swings of a Multiattack, in order: the first option when the stat block offers several.
// Uses that are not weapon attacks (Frightful Presence) are noted, not played.
function multiattackWeapons(monster, weaponByAction, notes) {
  const entry = (monster.actions ?? []).find((action) => action.name === "Multiattack");
  if (entry === undefined) return [];
  let steps = entry.actions ?? [];
  if (entry.action_options !== undefined) {
    const first = entry.action_options.from.options[0];
    steps = (first.option_type === "multiple" ? first.items : [first]).map((item) => ({ action_name: item.action_name, count: Number(item.count) || 1 }));
  }
  const weapons = [];
  for (const step of steps) {
    const weapon = weaponByAction.get(String(step.action_name).toLowerCase());
    if (weapon === undefined) notes.push(step.action_name);
    else for (let index = 0; index < (Number(step.count) || 1); index += 1) weapons.push(weapon);
  }
  return weapons;
}

// A breath weapon: a save-for-half action that recharges, shaped as a cone or line.
function areaTraitCode(monster, action) {
  if (action.dc === undefined || action.attack_bonus !== undefined || action.usage?.type !== "recharge on roll") return null;
  if (!/cone|line/.test(action.desc)) return null;
  const damage = damageList(monster, action);
  const reach = /(\d+)[- ](?:foot|ft)/.exec(action.desc);
  if (damage === null || reach === null) return null;
  const ability = abilityCodes[action.dc.dc_type.name.toLowerCase()] ?? action.dc.dc_type.index;
  const cooldown = Math.round(6 / (7 - action.usage.min_value));
  const weapon = weaponFor(action, damage.type);
  return `{ kind: "areaAttack", weapon: ${quote(weapon)}, ability: ${quote(ability)}, dc: ${action.dc.dc_value}, damage: ${damage.code}, damageType: ${quote(damage.type)}, halfOnSave: ${action.dc.success_type === "half"}, range: ${reach[1]}, cooldown: ${cooldown} }`;
}

for (const monster of monsters) {
  const id = `monster:${monster.index}`;
  if (knownMonsters.has(id)) continue;
  const notes = [];
  const attacks = [];
  let anyRanged = false;
  let anyMelee = false;
  const weaponByAction = new Map();
  const areaTraits = [];
  for (const action of monster.actions ?? []) {
    const area = areaTraitCode(monster, action);
    if (area !== null) {
      areaTraits.push(area);
      continue;
    }
    if (action.attack_bonus === undefined || (action.damage ?? []).length === 0) {
      if (action.name !== "Multiattack") notes.push(action.name);
      continue;
    }
    const damage = damageList(monster, action);
    if (damage === null) {
      notes.push(action.name);
      continue;
    }
    if (damage.multiple) notes.push(`${action.name}'s extra damage types are folded into one`);
    const weapon = weaponFor(action, damage.type);
    weaponByAction.set(action.name.toLowerCase(), weapon);
    const rider = riderCode(action);
    const ranged = /Ranged (Weapon|Spell) Attack/.test(action.desc);
    if (ranged) anyRanged = true;
    else anyMelee = true;
    attacks.push(`    { weapon: ${quote(weapon)}, toHit: ${action.attack_bonus}, damage: ${damage.code}${rider === null ? "" : `, onHit: [${rider}]`} }`);
  }
  if (attacks.length === 0 && areaTraits.length === 0) {
    // Nothing to swing: a monster that only casts, breathes or uses gaze cannot fight in this engine yet.
    notes.unshift("No weapon attack; it deals no damage yet");
  }
  if (attacks.length === 0) attacks.push(`    { weapon: "item:slam", toHit: 0, damage: flat(0) }`);
  const traits = [];
  const swings = multiattackWeapons(monster, weaponByAction, notes);
  if (swings.length > 1) traits.push(`{ kind: "multiattack", weapons: [${swings.map(quote).join(", ")}] }`);
  const abilityNames = (monster.special_abilities ?? []).map((ability) => ability.name);
  if (abilityNames.includes("Pack Tactics")) traits.push(`{ kind: "packTactics" }`);
  if (abilityNames.includes("Nimble Escape")) traits.push(`{ kind: "nimbleEscape" }`);
  traits.push(...areaTraits);
  for (const ability of monster.special_abilities ?? []) {
    if (ability.name === "Regeneration") {
      const amount = /regains (\d+) hit points/.exec(ability.desc);
      const blocker = /takes ([^.]*)\./.exec(ability.desc)?.[1] ?? "";
      if (amount !== null) {
        const blockedBy = damageTypes.filter((type) => blocker.toLowerCase().includes(type));
        traits.push(`{ kind: "regeneration", amount: ${amount[1]}, blockedBy: [${blockedBy.map(quote).join(", ")}] }`);
        continue;
      }
    }
    const resistance = ability.name === "Legendary Resistance" ? ability.usage?.times : undefined;
    if (resistance !== undefined) {
      traits.push(`{ kind: "legendaryResistance", uses: ${resistance} }`);
      continue;
    }
    if (!["Pack Tactics", "Nimble Escape"].includes(ability.name)) notes.push(ability.name);
  }
  for (const legendary of monster.legendary_actions ?? []) notes.push(`legendary: ${legendary.name}`);
  traits.push(...damageTraits(monster, notes));
  const speeds = Object.values(monster.speed ?? {}).map((text) => parseInt(text, 10)).filter(Number.isFinite);
  const walk = parseInt(monster.speed?.walk ?? "0", 10) || 0;
  const fly = parseInt(monster.speed?.fly ?? "0", 10) || 0;
  const speed = fly > 0 ? Math.max(walk, fly) : walk > 0 ? walk : Math.max(0, ...speeds);
  const armorClass = monster.armor_class[0].value;
  const tactic = anyRanged && !anyMelee ? "skirmisher" : "brute";
  const beast = monster.type === "beast" ? `
  beast: { challengeRating: ${monster.challenge_rating}, flies: ${(monster.speed?.fly ?? "") !== ""}, swims: ${(monster.speed?.swim ?? "") !== ""} },` : "";
  const name = camel(monster.index);
  const uniqueNotes = [...new Set(notes)];
  const comment = uniqueNotes.length === 0 ? "" : `// Not modeled: ${uniqueNotes.join("; ")}.\n`;
  monsterLines.push(`${comment}export const ${name} = defineMonster({
  id: ${quote(id)},
  source,
  armorClass: ${armorClass},
  maxHp: ${monster.hit_points},
  xp: ${monster.xp},
  speed: ${speed},
  abilityScores: { str: ${monster.strength}, dex: ${monster.dexterity}, con: ${monster.constitution}, int: ${monster.intelligence}, wis: ${monster.wisdom}, cha: ${monster.charisma} },
  attacks: [
${attacks.join(",\n")},
  ],
  tactic: ${quote(tactic)},
  traits: [${traits.join(", ")}],${beast}
});
`);
  monsterList.push(name);
  monsterNames[id] = monster.name;
}

// ------------------------------------------------------------------ output
const banner = `// GENERATED by tools/srd/generate.mjs from the 5e-bits SRD 5.1 database (MIT). Do not edit by hand; change the generator and run it again.\n`;
const naturalLines = [];
const naturalNames = [];
for (const [id, weapon] of naturalById) {
  const key = camel(id.slice(5));
  const range = weapon.ranged ? `{ kind: "ranged", normal: ${weapon.normal}, long: ${weapon.long} }` : "melee";
  naturalLines.push(`export const ${key} = defineWeapon({ id: ${quote(id)}, source, damage: dice(1, 6), damageType: ${quote(weapon.type)}, range: ${range}, finesse: false, natural: true });`);
  naturalNames.push(key);
  itemNames[id] = weapon.name;
}

writeFileSync(
  join(content, "items/srd-equipment.generated.ts"),
  `${banner}import { dice, flat } from "../../../dice/dice-expression.js";
import { defineArmor, defineWeapon, type ItemDefinition } from "../../../rules/content-definitions.js";

const source = "SRD 5.1";
const melee = { kind: "melee" } as const;

${weaponLines.join("\n")}
${armorLines.join("\n")}

// What generated monsters bite, claw and slam with. The damage die here is a
// placeholder: each monster's attack carries its own damage.
${naturalLines.join("\n")}

export const srd51GeneratedItems: readonly ItemDefinition[] = [
${[...equipmentIds, ...naturalNames].map((name) => `  ${name},`).join("\n")}
];
`,
);
writeFileSync(
  join(content, "monsters/srd-monsters.generated.ts"),
  `${banner}import { combine, dice, flat, plus } from "../../../dice/dice-expression.js";
import { defineMonster, type MonsterDefinition } from "../../../rules/content-definitions.js";

// The rest of the SRD 5.1 bestiary. Attacks, defenses and numbers are the stat
// block's; each monster's comment lists what the engine does not model yet, so
// it plays a little weaker than written.
const source = "SRD 5.1";

${monsterLines.join("\n")}
export const srd51GeneratedMonsters: readonly MonsterDefinition[] = [
${monsterList.map((name) => `  ${name},`).join("\n")}
];
`,
);
const allNames = { ...monsterNames, ...itemNames };
const zhNames = JSON.parse(readFileSync(join(here, "zh-tw-names.json"), "utf8"));
const missingZh = Object.keys(allNames).filter((id) => zhNames[id] === undefined);
if (missingZh.length > 0) throw new Error(`No Chinese name for: ${missingZh.join(", ")}. Add them to tools/srd/zh-tw-names.json.`);
const namesFile = (table, note) => {
  const rows = Object.keys(allNames).map((id) => `  ${quote(id)}: ${quote(table[id])},`);
  // The spell names come from tools/srd/generate-spells.mjs, and join here so the glossaries need one import.
  return [banner + `// ${note}`, 'import { srd51SpellNames } from "./srd-spell-names.js";', "", "export const srd51GeneratedNames: Readonly<Record<string, string>> = {", ...rows, "  ...srd51SpellNames,", "};", ""].join(String.fromCharCode(10));
};
const glossaryDir = join(root, "src/application/i18n/campaign/glossary");
writeFileSync(join(glossaryDir, "en/srd-generated-names.ts"), namesFile(allNames, "English names for the generated SRD 5.1 monsters and items."));
writeFileSync(join(glossaryDir, "zh-TW/srd-generated-names.ts"), namesFile(zhNames, "Traditional Chinese names for the generated SRD 5.1 monsters and items."));
process.stdout.write(`monsters ${monsterList.length}, items ${equipmentIds.length}, natural weapons ${naturalNames.length}${String.fromCharCode(10)}`);
