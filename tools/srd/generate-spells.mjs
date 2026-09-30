// Generates the SRD 5.1 spells from the open 5e-bits database (MIT).
//
//   node tools/srd/generate-spells.mjs "<folder with Spells.json>"
//
// A spell gets a real mechanical plan when the data says how it works: a spell
// attack or a saving throw that deals damage (scaled by slot level or character
// level), healing, a condition that a failed save lays on, or one of a short list
// of buffs written out below. Every other spell (teleports, divinations, summons,
// walls) is content the table can cast and the Narrator can describe, with a plan
// that changes nothing; each carries a comment saying so.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const input = process.argv[2];
if (input === undefined) throw new Error("Pass the folder that holds Spells.json.");
const spells = JSON.parse(readFileSync(join(input, "Spells.json"), "utf8"));
const zhNames = JSON.parse(readFileSync(join(here, "zh-tw-spell-names.json"), "utf8"));
const spellDir = join(root, "src/domain/campaign/content/srd-5.1/spells");
const glossaryDir = join(root, "src/application/i18n/campaign/glossary");

const quote = (text) => JSON.stringify(text);
const camel = (index) => index.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
const nl = String.fromCharCode(10);

// ------------------------------------------------ what is already hand-written
const handWritten = new Set();
for (const file of readdirSync(spellDir)) {
  if (file.endsWith(".generated.ts") || !file.endsWith(".ts")) continue;
  for (const match of readFileSync(join(spellDir, file), "utf8").matchAll(/id: "spell:([a-z0-9-]+)"/g)) handWritten.add(match[1]);
}
// The book lists Tasha's Hideous Laughter twice.
handWritten.add("hideous-laughter");

// ------------------------------------------------------------------ parsing
const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const conditionOf = { charmed: "charmed", frightened: "frightened", paralyzed: "paralyzed", stunned: "stunned", blinded: "blinded", restrained: "restrained", incapacitated: "incapacitated", poisoned: "poisoned", prone: "prone", unconscious: "unconscious" };
const damageTypes = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];

function diceRow(source) {
  // "4d6 OR 5d6" (upcast choices) keeps the last; " + MOD" is added by the plan, not here.
  const text = source.split(" OR ").at(-1).replace(/\s*\+\s*MOD/, "");
  const match = /^\s*(\d+)d(\d+)(?:\s*\+\s*(\d+))?\s*$/.exec(text);
  if (match !== null) return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const flat = /^\s*(\d+)\s*$/.exec(text);
  return flat === null ? null : [0, 0, Number(flat[1])];
}

// A table of dice by level ("slot" or "character") as source text, or null when the spell has none or the dice do not parse.
function damageTable(entry) {
  const table = entry.damage_at_slot_level ?? entry.damage_at_character_level ?? null;
  if (table === null) return null;
  const rows = {};
  for (const [level, text] of Object.entries(table)) {
    const row = diceRow(text);
    if (row === null || (row[1] !== 0 && ![4, 6, 8, 10, 12, 20, 100].includes(row[1]))) return null;
    rows[level] = row;
  }
  const modifier = Object.values(table).some((text) => text.includes("MOD"));
  return { rows, by: entry.damage_at_slot_level === undefined ? "character" : "slot", modifier };
}

const castingTimeOf = (text) => (text === "1 action" ? "action" : text === "1 bonus action" ? "bonus-action" : text === "1 reaction" || text.startsWith("1 reaction") ? "reaction" : "long");

function rangeOf(spell) {
  const text = spell.range;
  const size = spell.area_of_effect?.size;
  if (/^Self/i.test(text)) return size === undefined ? { kind: "self" } : { kind: "feet", feet: size };
  if (/^Touch/i.test(text)) return { kind: "touch" };
  const feet = /^(\d+) feet/.exec(text);
  if (feet !== null) return { kind: "feet", feet: Number(feet[1]) };
  const miles = /^(\d+) miles?/.exec(text);
  if (miles !== null) return { kind: "feet", feet: 500 };
  return { kind: "feet", feet: 120 };
}

const description = (spell) => spell.desc.join(" ").replace(/\s+/g, " ");

function targetCount(spell) {
  const text = description(spell).toLowerCase();
  if (spell.area_of_effect !== undefined) return 6;
  const upTo = /up to (\w+) (?:creatures|targets|willing creatures|humanoids|beasts|allies|objects)/.exec(text);
  if (upTo !== null) return numberWords[upTo[1]] ?? (Number.isFinite(Number(upTo[1])) ? Number(upTo[1]) : 1);
  const several = /(\w+) (?:creatures|targets) of your choice/.exec(text);
  if (several !== null && numberWords[several[1]] !== undefined) return numberWords[several[1]];
  return 1;
}

function higherTargets(spell) {
  const text = (spell.higher_level ?? []).join(" ").toLowerCase();
  const word = /(\w+) additional (?:creature|target)/.exec(text);
  if (word !== null) return numberWords[word[1]] ?? 1;
  return /additional (?:creature|target)/.test(text) ? 1 : 0;
}

// Duration in rounds; "untilRemoved" when it outlasts a fight.
function durationOf(spell) {
  const text = spell.duration.toLowerCase();
  if (text === "instantaneous") return { kind: "rounds", count: 1 };
  const rounds = /(\d+) round/.exec(text);
  if (rounds !== null) return { kind: "rounds", count: Number(rounds[1]) };
  const minutes = /(\d+) minute/.exec(text);
  if (minutes !== null && Number(minutes[1]) <= 1) return { kind: "rounds", count: 10 * Number(minutes[1]) };
  return { kind: "untilRemoved" };
}
const durationCode = (duration) => (duration.kind === "rounds" ? `{ kind: "rounds", count: ${duration.count} }` : `{ kind: "untilRemoved" }`);

function conditionRider(spell) {
  const text = description(spell).toLowerCase();
  const match = /saving throw[^.]*?(?:be|become|is|are) (?:knocked )?(charmed|frightened|paralyzed|stunned|blinded|restrained|incapacitated|poisoned|prone|unconscious)/.exec(text);
  if (match === null || spell.dc === undefined) return null;
  return { ability: spell.dc.dc_type.index, condition: conditionOf[match[1]] };
}

// ------------------------------------------------------- curated buffs / control
// Spells whose data does not say what they do in the engine's terms. Each is a
// deliberate approximation, named in the comment the generator writes above it.
const curated = {
  "mage-armor": { relation: "ally-or-self", count: 1, note: "Armor class +3 stands in for 13 + Dexterity.", effects: [{ modifiers: [{ kind: "acBonus", amount: 3 }], duration: { kind: "untilRemoved" } }] },
  "shield-of-faith": { relation: "ally-or-self", count: 1, note: "", effects: [{ modifiers: [{ kind: "acBonus", amount: 2 }], duration: { kind: "untilRemoved" } }] },
  barkskin: { relation: "ally-or-self", count: 1, note: "Armor class +3 stands in for a floor of 16.", effects: [{ modifiers: [{ kind: "acBonus", amount: 3 }], duration: { kind: "untilRemoved" } }] },
  haste: { relation: "ally-or-self", count: 1, note: "Armor class +2 and advantage on Dexterity saves; the extra action and doubled speed are not modeled.", effects: [{ modifiers: [{ kind: "acBonus", amount: 2 }, { kind: "saves", ability: "dex", mode: "advantage" }], duration: { kind: "untilRemoved" } }] },
  blur: { relation: "self", count: 1, note: "", effects: [{ modifiers: [{ kind: "attacksAgainst", mode: "disadvantage", reach: "any" }], duration: { kind: "untilRemoved" } }] },
  "protection-from-evil-and-good": { relation: "ally-or-self", count: 1, note: "Disadvantage against every attacker stands in for disadvantage against aberrations, celestials, elementals, fey, fiends and undead.", effects: [{ modifiers: [{ kind: "attacksAgainst", mode: "disadvantage", reach: "any" }], duration: { kind: "untilRemoved" } }] },
  heroism: { relation: "ally-or-self", count: 1, note: "Only the bonus to frightened saves is kept as advantage; the temporary hit points are not modeled.", effects: [{ modifiers: [{ kind: "saves", ability: "wis", mode: "advantage" }], duration: { kind: "untilRemoved" } }] },
  "faerie-fire": { relation: "enemy", count: 6, save: "dex", note: "Everyone in the area is lit, not only those who fail.", effects: [{ modifiers: [{ kind: "attacksAgainst", mode: "advantage", reach: "any" }], duration: { kind: "untilRemoved" }, onLand: true }] },
  bane: { relation: "enemy", count: 3, save: "cha", countPerHigherSlot: 1, note: "Disadvantage on attacks and saves stands in for the subtracted d4.", effects: [{ modifiers: [{ kind: "ownAttacks", mode: "disadvantage" }, { kind: "saves", ability: "any", mode: "disadvantage" }], duration: { kind: "untilRemoved" }, onLand: true }] },
  slow: { relation: "enemy", count: 6, save: "wis", note: "Armor class -2 and disadvantage on Dexterity saves; the lost action and halved speed are not modeled.", effects: [{ modifiers: [{ kind: "acBonus", amount: -2 }, { kind: "saves", ability: "dex", mode: "disadvantage" }], duration: { kind: "untilRemoved" }, onLand: true }] },
  invisibility: { relation: "ally-or-self", count: 1, note: "", effects: [{ condition: "invisible", duration: { kind: "untilRemoved" } }] },
  "greater-invisibility": { relation: "ally-or-self", count: 1, note: "", effects: [{ condition: "invisible", duration: { kind: "untilRemoved" } }] },
  sleep: { relation: "enemy", count: 3, save: "wis", countPerHigherSlot: 2, note: "A Wisdom save on up to three creatures stands in for the hit point pool of 5d8; sleepers do not wake when hurt.", effects: [{ condition: "unconscious", duration: { kind: "rounds", count: 10 }, onLand: true }] },
  "hypnotic-pattern": { relation: "enemy", count: 6, save: "wis", note: "", effects: [{ condition: "incapacitated", duration: { kind: "rounds", count: 10 }, onLand: true }] },
  "color-spray": { relation: "enemy", count: 6, save: null, note: "Blinds up to six creatures for a round with no save and no hit point pool.", effects: [{ condition: "blinded", duration: { kind: "rounds", count: 1 }, onLand: true }] },
  "power-word-stun": { relation: "enemy", count: 1, save: null, note: "The hit point threshold is not checked.", effects: [{ condition: "stunned", duration: { kind: "rounds", count: 10 }, onLand: true }] },
  "power-word-kill": { relation: "enemy", count: 1, save: null, note: "Deals 100 force damage rather than killing outright, and the hit point threshold is not checked.", effects: [{ damage: [[0, 0, 100]], damageType: "force", onLand: true }] },
  "animal-friendship": { relation: "enemy", count: 1, save: "wis", note: "", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  "charm-person": { relation: "enemy", count: 1, save: "wis", countPerHigherSlot: 1, note: "", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  entangle: { relation: "enemy", count: 6, save: "str", note: "", effects: [{ condition: "restrained", duration: { kind: "untilRemoved" }, onLand: true }] },
  "dominate-person": { relation: "enemy", count: 1, save: "wis", note: "Charmed stands in for full control.", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  "dominate-beast": { relation: "enemy", count: 1, save: "wis", note: "Charmed stands in for full control.", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  "dominate-monster": { relation: "enemy", count: 1, save: "wis", note: "Charmed stands in for full control.", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  "flesh-to-stone": { relation: "enemy", count: 1, save: "con", note: "Restrained stands in for the slow petrification.", effects: [{ condition: "restrained", duration: { kind: "untilRemoved" }, onLand: true }] },
  "irresistible-dance": { relation: "enemy", count: 1, save: "wis", note: "Incapacitated stands in for the compelled dance.", effects: [{ condition: "incapacitated", duration: { kind: "untilRemoved" }, onLand: true }] },
  confusion: { relation: "enemy", count: 6, save: "wis", note: "Incapacitated stands in for the random behavior.", effects: [{ condition: "incapacitated", duration: { kind: "untilRemoved" }, onLand: true }] },
  "phantasmal-killer": { relation: "enemy", count: 1, save: "wis", note: "Frightened, and no damage each turn.", effects: [{ condition: "frightened", duration: { kind: "untilRemoved" }, onLand: true }] },
  "blindness-deafness": { relation: "enemy", count: 1, save: "con", note: "Blinds; the deafness option is not modeled.", effects: [{ condition: "blinded", duration: { kind: "rounds", count: 10 }, onLand: true }] },
  banishment: { relation: "enemy", count: 1, save: "cha", countPerHigherSlot: 1, note: "Incapacitated stands in for being sent to another plane.", effects: [{ condition: "incapacitated", duration: { kind: "untilRemoved" }, onLand: true }] },
  suggestion: { relation: "enemy", count: 1, save: "wis", note: "Charmed stands in for the suggested course of action.", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  "mass-suggestion": { relation: "enemy", count: 12, save: "wis", note: "Charmed stands in for the suggested course of action.", effects: [{ condition: "charmed", duration: { kind: "untilRemoved" }, onLand: true }] },
  "stinking-cloud": { relation: "enemy", count: 6, save: "con", note: "Poisoned stands in for a turn lost to retching.", effects: [{ condition: "poisoned", duration: { kind: "untilRemoved" }, onLand: true }] },
  "ray-of-enfeeblement": { relation: "enemy", count: 1, save: null, note: "Disadvantage on attacks stands in for the halved Strength damage; the target gets no save on the first blow.", effects: [{ modifiers: [{ kind: "ownAttacks", mode: "disadvantage" }], duration: { kind: "untilRemoved" }, onLand: true }] },
  "bestow-curse": { relation: "enemy", count: 1, save: "wis", note: "Only the curse on attack rolls is modeled.", effects: [{ modifiers: [{ kind: "ownAttacks", mode: "disadvantage" }], duration: { kind: "untilRemoved" }, onLand: true }] },
  grease: { relation: "enemy", count: 6, save: "dex", note: "", effects: [{ condition: "prone", duration: { kind: "rounds", count: 1 }, onLand: true }] },
  weird: { relation: "enemy", count: 6, save: "wis", note: "Frightened stands in for the psychic damage each turn.", effects: [{ condition: "frightened", duration: { kind: "untilRemoved" }, onLand: true }] },
  eyebite: { relation: "enemy", count: 1, save: "wis", note: "Only the frightening option is modeled.", effects: [{ condition: "frightened", duration: { kind: "untilRemoved" }, onLand: true }] },
  "conjure-animals": { relation: "self", count: 1, summon: { monster: "brown-bear", count: 2 }, note: "Two brown bears stand in for the beasts the caster would choose; they fight until the fight ends, not for the spell's minute.", effects: [] },
  "spiritual-weapon": { relation: "self", count: 1, summon: { monster: "spiritual-weapon", count: 1 }, note: "A spectral weapon fights beside the caster until the fight ends, as a creature with its own turn; the book makes it a bonus action each turn and untargetable.", effects: [] },
  web: { relation: "enemy", count: 6, save: "dex", note: "Restrained until it breaks free, which is not modeled.", effects: [{ condition: "restrained", duration: { kind: "untilRemoved" }, onLand: true }] },
  resistance: { relation: "ally-or-self", count: 1, save: null, note: "The d4 goes on the next saving throw for a minute (it is not used up).", effects: [{ modifiers: [{ kind: "bonusDie", die: { terms: [{ count: 1, sides: 4 }], modifier: 0 }, appliesTo: ["save"], source: "spell:resistance" }], duration: { kind: "rounds", count: 10 } }] },
  "true-strike": { relation: "self", count: 1, note: "Advantage on attacks for the caster's next turn stands in for advantage on the first attack.", effects: [{ modifiers: [{ kind: "ownAttacks", mode: "advantage" }], duration: { kind: "rounds", count: 2 } }] },
  "magic-weapon": { relation: "ally-or-self", count: 1, note: "The bonus goes on every attack and every melee damage roll the creature makes, not on one weapon.", effects: [{ modifiers: [{ kind: "attackBonus", amount: 1 }, { kind: "meleeDamageBonus", amount: 1 }], duration: { kind: "untilRemoved" } }] },
  "protection-from-energy": { relation: "ally-or-self", count: 1, note: "Resistance to fire stands in for the damage type the caster would choose.", effects: [{ modifiers: [{ kind: "damageResistance", damageTypes: ["fire"] }], duration: { kind: "untilRemoved" } }] },
  stoneskin: { relation: "ally-or-self", count: 1, note: "", effects: [{ modifiers: [{ kind: "damageResistance", damageTypes: ["bludgeoning", "piercing", "slashing"] }], duration: { kind: "untilRemoved" } }] },
  longstrider: { relation: "ally-or-self", count: 1, note: "", effects: [{ modifiers: [{ kind: "speedBonus", amount: 10 }], duration: { kind: "untilRemoved" } }] },
  "expeditious-retreat": { relation: "self", count: 1, note: "Thirty more feet of movement each turn stands in for the Dash as a bonus action.", effects: [{ modifiers: [{ kind: "speedBonus", amount: 30 }], duration: { kind: "untilRemoved" } }] },
  fly: { relation: "ally-or-self", count: 1, note: "Thirty more feet of movement each turn stands in for the flying speed; flying itself is not modeled.", effects: [{ modifiers: [{ kind: "speedBonus", amount: 30 }], duration: { kind: "untilRemoved" } }] },
  "misty-step": { relation: "self", count: 1, note: "Thirty feet of movement that provokes no opportunity attacks stands in for the teleport; the caster walks to the zone.", effects: [{ movement: 30 }, { modifiers: [{ kind: "avoidsOpportunityAttacks" }], duration: { kind: "rounds", count: 1 } }] },
  "mirror-image": { relation: "self", count: 1, note: "Armor class +3 stands in for the three duplicates.", effects: [{ modifiers: [{ kind: "acBonus", amount: 3 }], duration: { kind: "rounds", count: 10 } }] },
  "enlarge-reduce": { relation: "ally-or-self", count: 1, note: "Only Enlarge is modeled: +2 melee damage stands in for the extra d4.", effects: [{ modifiers: [{ kind: "meleeDamageBonus", amount: 2 }], duration: { kind: "rounds", count: 10 } }] },
  "animate-dead": { relation: "self", count: 1, summon: { monster: "skeleton", count: 1 }, note: "A skeleton fights beside the caster until the fight ends; it does not need a corpse and is not raised for a day.", effects: [] },
  "conjure-minor-elementals": { relation: "self", count: 1, summon: { monster: "steam-mephit", count: 4 }, note: "Four steam mephits stand in for the elementals the caster would choose.", effects: [] },
  "conjure-woodland-beings": { relation: "self", count: 1, summon: { monster: "satyr", count: 2 }, note: "Two satyrs stand in for the fey the caster would choose.", effects: [] },
  "conjure-elemental": { relation: "self", count: 1, summon: { monster: "fire-elemental", count: 1 }, note: "A fire elemental stands in for the elemental the caster would choose; it does not turn on the caster if concentration slips.", effects: [] },
  "conjure-celestial": { relation: "self", count: 1, summon: { monster: "couatl", count: 1 }, note: "A couatl stands in for the celestial the caster would choose.", effects: [] },
  "giant-insect": { relation: "self", count: 1, summon: { monster: "giant-centipede", count: 3 }, note: "Three giant centipedes stand in for the insects the caster would grow.", effects: [] },
  "animate-objects": { relation: "self", count: 1, summon: { monster: "flying-sword", count: 6 }, note: "Six flying swords stand in for the objects the caster would animate.", effects: [] },
  "create-undead": { relation: "self", count: 1, summon: { monster: "ghoul", count: 3 }, note: "Three ghouls stand in for the undead the caster would raise; they do not need corpses and obey until the fight ends.", effects: [] },
  darkness: { relation: "enemy", count: 6, save: null, note: "Blinds the creatures in the area for the duration; there is no lighting in the engine.", effects: [{ condition: "blinded", duration: { kind: "untilRemoved" }, onLand: true }] },
};

// ------------------------------------------------------------------ emission
const tables = [];
const spellLines = [];
const names = {};
const classLists = {};
const summary = { damage: 0, save: 0, heal: 0, condition: 0, curated: 0, narrative: 0 };

function tableConst(name, rows) {
  const entries = Object.entries(rows).map(([level, row]) => `${level}: [${row.join(", ")}]`);
  tables.push(`const ${name}: DiceTable = { ${entries.join(", ")} };`);
  return name;
}

// Damage the data gives only in words ("takes 4d6 fire damage"): read from the description, and scaled by slot from the higher-level text.
function textualDamage(spell, type) {
  const text = description(spell);
  const match = new RegExp(String.raw`(\d+)d(\d+)(?: \+ (\d+))? (?:[a-z]+ )?${type} damage`).exec(text);
  if (match === null) return null;
  const row = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const rows = { [spell.level]: row };
  const more = /(\d+)d(\d+) for each slot level above/.exec((spell.higher_level ?? []).join(" "));
  if (more !== null && Number(more[2]) === row[1]) for (let level = spell.level + 1; level <= 9; level += 1) rows[level] = [row[0] + (level - spell.level) * Number(more[1]), row[1], row[2]];
  return { rows, by: "slot" };
}

function damageEffects(spell, note) {
  const out = [];
  let anyHalf = false;
  for (const [index, entry] of (spell.damage ?? []).entries()) {
    const type = entry.damage_type?.index;
    if (!damageTypes.includes(type)) continue;
    const table = damageTable(entry) ?? textualDamage(spell, type);
    if (table === null) return null;
    const name = tableConst(`${camel(spell.index)}Damage${index === 0 ? "" : index + 1}`, table.rows);
    const amount = table.by === "slot" ? `diceAt(${name}, slotLevel)` : `diceAt(${name}, casterLevel)`;
    out.push({ amount: table.modifier === true ? `plus(${amount}, spellcastingModifier)` : amount, type, by: table.by });
  }
  void note;
  void anyHalf;
  return out.length === 0 ? null : out;
}

function planFor(spell, notes) {
  const half = spell.dc?.dc_success === "half";
  const attack = spell.attack_type !== undefined || /make a (ranged|melee) spell attack/i.test(description(spell));
  const save = spell.dc === undefined ? null : spell.dc.dc_type.index;
  const uses = { slot: false, level: false, modifier: false };
  const scan = (code) => {
    if (code.includes("slotLevel")) uses.slot = true;
    if (code.includes("casterLevel")) uses.level = true;
    if (code.includes("spellcastingModifier")) uses.modifier = true;
    return code;
  };
  const wrap = (body) => {
    const params = [uses.slot ? "slotLevel" : null, uses.level ? "casterLevel" : null, uses.modifier ? "spellcastingModifier" : null].filter((entry) => entry !== null);
    return `plan: (${params.length === 0 ? "" : `{ ${params.join(", ")} }`}) => (${body}),`;
  };
  const effectCode = (effect) => `{ kind: "damage", target: "target", amount: ${effect.amount}, damageType: ${quote(effect.type)} }`;
  const halfCode = (effect) => `{ kind: "damage", target: "target", amount: ${effect.amount}, damageType: ${quote(effect.type)}, halfOfLand: true }`;

  // Curated first.
  const special = curated[spell.index];
  if (special !== undefined) {
    summary.curated += 1;
    if (special.note !== "") notes.push(special.note);
    if (special.summon !== undefined) return { relation: special.relation, count: special.count, countPerHigherSlot: 0, body: `{ check: null, onLand: [{ kind: "summon", target: "self", monsterId: "monster:${special.summon.monster}", count: ${special.summon.count} }], onAvoid: [] }`, params: uses, wrap };
    const land = [];
    const self = [];
    for (const effect of special.effects) {
      let code;
      if (effect.movement !== undefined) code = `{ kind: "grantMovement", target: "target", feet: ${effect.movement} }`;
      else if (effect.damage !== undefined) code = `{ kind: "damage", target: "target", amount: ${effect.damage[0][0] === 0 ? `flat(${effect.damage[0][2]})` : "flat(0)"}, damageType: ${quote(effect.damageType)} }`;
      else if (effect.condition !== undefined) code = `{ kind: "applyCondition", target: "target", condition: "condition:${effect.condition}", duration: ${durationCode(effect.duration)} }`;
      else code = `{ kind: "applyModifiers", target: "target", modifiers: ${JSON.stringify(effect.modifiers).replace(/"([a-zA-Z]+)":/g, "$1:").replace(/,/g, ", ").replace(/:/g, ": ").replace(/\{/g, "{ ").replace(/\}/g, " }")}, duration: ${durationCode(effect.duration)} }`;
      (effect.onLand === true || special.save !== undefined ? land : self).push(code);
    }
    const check = special.save === undefined || special.save === null ? "null" : `{ kind: "savingThrow", ability: ${quote(special.save)} }`;
    const onLand = special.save === undefined ? self : land;
    return { relation: special.relation, count: special.count, countPerHigherSlot: special.countPerHigherSlot ?? 0, body: `{ check: ${check}, onLand: [${onLand.join(", ")}], onAvoid: [] }`, params: uses, wrap };
  }

  const damage = damageEffects(spell, notes);
  if ((attack || save !== null) && damage !== null) {
    summary.damage += 1;
    const check = attack ? `{ kind: "spellAttack" }` : `{ kind: "savingThrow", ability: ${quote(save)} }`;
    const land = damage.map(effectCode).map(scan);
    const avoid = !attack && half ? damage.map(halfCode).map(scan) : [];
    if (spell.area_of_effect !== undefined || half) notes.push("");
    return { relation: "enemy", count: targetCount(spell), countPerHigherSlot: higherTargets(spell), body: `{ check: ${check}, onLand: [${land.join(", ")}], onAvoid: [${avoid.join(", ")}] }`, params: uses, wrap };
  }
  if (damage !== null && save === null && !attack) {
    // Damage with no roll to avoid it (Magic Missile's kin): it simply lands.
    summary.damage += 1;
    return { relation: "enemy", count: targetCount(spell), countPerHigherSlot: higherTargets(spell), body: `{ check: null, onLand: [${damage.map(effectCode).map(scan).join(", ")}], onAvoid: [] }`, params: uses, wrap };
  }
  if (spell.heal_at_slot_level !== undefined) {
    const rows = {};
    for (const [level, text] of Object.entries(spell.heal_at_slot_level)) {
      const row = diceRow(text);
      if (row === null) return null;
      rows[level] = row;
    }
    const name = tableConst(`${camel(spell.index)}Healing`, rows);
    const modifier = /spellcasting ability modifier/i.test(description(spell));
    summary.heal += 1;
    const amount = modifier ? `plus(diceAt(${name}, slotLevel), spellcastingModifier)` : `diceAt(${name}, slotLevel)`;
    return { relation: "ally-or-self", count: targetCount(spell), countPerHigherSlot: higherTargets(spell), body: `{ check: null, onLand: [${scan(`{ kind: ${spell.index === "false-life" ? "\"tempHp\"" : "\"heal\""}, target: "target", amount: ${amount} }`)}], onAvoid: [] }`, params: uses, wrap };
  }
  const rider = conditionRider(spell);
  if (rider !== null && save !== null && rider.condition !== undefined) {
    summary.condition += 1;
    const duration = spell.concentration ? durationOf(spell) : { kind: "rounds", count: 10 };
    const bounded = duration.kind === "rounds" && duration.count === 1 && !spell.concentration ? { kind: "rounds", count: 1 } : duration;
    return { relation: "enemy", count: targetCount(spell), countPerHigherSlot: higherTargets(spell), body: `{ check: { kind: "savingThrow", ability: ${quote(rider.ability)} }, onLand: [{ kind: "applyCondition", target: "target", condition: "condition:${rider.condition}", duration: ${durationCode(bounded)} }], onAvoid: [] }`, params: uses, wrap };
  }
  return null;
}

// Every SRD spell each class may cast, the hand-written ones included.
for (const spell of spells) {
  const id = spell.index === "hideous-laughter" ? "spell:tashas-hideous-laughter" : `spell:${spell.index}`;
  for (const entry of spell.classes ?? []) {
    const list = (classLists[entry.index] ??= []);
    if (!list.includes(id)) list.push(id);
  }
}

for (const spell of spells) {
  if (handWritten.has(spell.index)) continue;
  if (zhNames[spell.index] === undefined) throw new Error(`No Chinese name for ${spell.index}. Add it to tools/srd/zh-tw-spell-names.json.`);
  const notes = [];
  const planned = planFor(spell, notes);
  // Thunderwave: a creature that fails its save is also pushed away (into the next zone, or out of the melee).
  if (spell.index === "thunderwave" && planned !== null) planned.body = planned.body.replace("], onAvoid:", ", { kind: \"push\", target: \"target\" }], onAvoid:");
  const range = rangeOf(spell);
  const castingTime = castingTimeOf(spell.casting_time);
  const name = camel(spell.index);
  let relation;
  let count;
  let perHigher = 0;
  let plan;
  if (planned === null) {
    summary.narrative += 1;
    relation = range.kind === "self" ? "self" : range.kind === "touch" ? "ally-or-self" : "creature";
    count = relation === "self" ? 1 : targetCount(spell);
    perHigher = higherTargets(spell);
    plan = "plan: () => ({ check: null, onLand: [], onAvoid: [] }),";
    notes.unshift("Narrative only: casting it spends the slot and the Narrator describes it; the engine changes nothing.");
  } else {
    relation = planned.relation;
    count = planned.count;
    perHigher = planned.countPerHigherSlot;
    plan = planned.wrap(planned.body);
    if (range.kind === "self" && relation !== "self" && spell.area_of_effect === undefined) relation = "self";
  }
  const cleanNotes = notes.filter((note) => note !== "");
  const comment = cleanNotes.length === 0 ? "" : cleanNotes.map((note) => `// ${note}`).join(nl) + nl;
  const rangeCode = range.kind === "feet" ? `{ kind: "feet", feet: ${range.feet} }` : `{ kind: ${quote(range.kind)} }`;
  const targeting = `{ relation: ${quote(relation)}, count: ${count}${perHigher > 0 ? `, countPerHigherSlot: ${perHigher}` : ""} }`;
  spellLines.push(`${comment}export const ${name} = defineSpell({
  id: ${quote(`spell:${spell.index}`)},
  source,
  level: ${spell.level},
  castingTime: ${quote(castingTime)},
  range: ${rangeCode},
  targeting: ${targeting},
  concentration: ${spell.concentration},${spell.ritual ? nl + "  ritual: true," : ""}
  ${plan}
});
`);
  names[`spell:${spell.index}`] = spell.name;
  spell.__const = name;
}

const banner = `// GENERATED by tools/srd/generate-spells.mjs from the 5e-bits SRD 5.1 database (MIT). Do not edit by hand; change the generator and run it again.${nl}`;
const constNames = spells.filter((spell) => spell.__const !== undefined).map((spell) => spell.__const);
writeFileSync(
  join(spellDir, "srd-spells.generated.ts"),
  `${banner}import { flat, plus } from "../../../dice/dice-expression.js";
import { defineSpell, type SpellDefinition } from "../../../rules/content-definitions.js";
import { diceAt, type DiceTable } from "./dice-tables.js";

const source = "SRD 5.1";

${tables.join(nl)}

${spellLines.join(nl)}
export const srd51GeneratedSpells: readonly SpellDefinition[] = [
${constNames.map((name) => `  ${name},`).join(nl)}
];
`,
);

// Class spell lists: every SRD spell each caster class may cast, one constant per class.
const casterClasses = ["bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"];
const listLines = casterClasses.map((className) => `export const srd51${className[0].toUpperCase()}${className.slice(1)}Spells: readonly ContentId<"spell">[] = [${(classLists[className] ?? []).map(quote).join(", ")}];`);
writeFileSync(
  join(spellDir, "class-spell-lists.generated.ts"),
  `${banner}import type { ContentId } from "../../../rules/content-id.js";

// Every SRD 5.1 spell each caster class may cast (alphabetical by id).
${listLines.join(nl)}
`,
);

// The school of magic of every SRD spell, for the rules that name one (Empowered Evocation).
const schoolRows = spells.map((spell) => `  ${quote(`spell:${spell.index}`)}: ${quote(spell.school.index)},`);
writeFileSync(
  join(spellDir, "spell-schools.generated.ts"),
  [banner + "import type { SpellSchool } from \"../../../rules/content-definitions.js\";", "", "// The school of every SRD 5.1 spell.", "export const srd51SpellSchools: Readonly<Record<string, SpellSchool>> = {", ...schoolRows, "};", ""].join(nl),
);

const namesFile = (table, note) => {
  const rows = Object.keys(names).map((id) => `  ${quote(id)}: ${quote(table[id])},`);
  return [banner + `// ${note}`, "export const srd51SpellNames: Readonly<Record<string, string>> = {", ...rows, "};", ""].join(nl);
};
const zhById = Object.fromEntries(Object.keys(names).map((id) => [id, zhNames[id.slice(6)]]));
writeFileSync(join(glossaryDir, "en/srd-spell-names.ts"), namesFile(names, "English names for the generated SRD 5.1 spells."));
writeFileSync(join(glossaryDir, "zh-TW/srd-spell-names.ts"), namesFile(zhById, "Traditional Chinese names for the generated SRD 5.1 spells."));
process.stdout.write(`spells ${constNames.length}: ${JSON.stringify(summary)}${nl}`);
