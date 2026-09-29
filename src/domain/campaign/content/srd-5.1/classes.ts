import { srd51BardSpells, srd51ClericSpells, srd51DruidSpells, srd51PaladinSpells, srd51RangerSpells, srd51SorcererSpells, srd51WarlockSpells, srd51WizardSpells } from "./spells/class-spell-lists.generated.js";
import { defineClass, type ClassDefinition } from "../../rules/content-definitions.js";

// The full SRD 5.1 class roster, as sealed content: everything the builder
// and leveling need for one class in one place, validated the same way a
// spell or monster is (checkDefinition resolves every kit item, feature and
// spell it names). Level 1 only, plus the levels-2+ progression a class
// grants on its own (character/leveling.ts turns XP into levels; the numbers
// that follow from a level alone — HP, proficiency, spell slot counts, ASIs —
// stay there, formula-driven, rather than repeated per class here).
const source = "SRD 5.1";

export const fighter = defineClass({
  id: "class:fighter",
  source,
  hitDie: 10,
  savingThrows: ["str", "con"],
  skillChoices: ["acrobatics", "animal-handling", "athletics", "history", "insight", "intimidation", "perception", "survival"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:fighting-style-dueling", "feature:second-wind"],
  kits: [
    { id: "knight", equipment: ["item:longsword", "item:chain-mail", "item:shield"] },
    { id: "skirmisher", equipment: ["item:scimitar", "item:shortbow", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["str", "con", "dex", "wis", "int", "cha"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: {
    2: ["feature:action-surge"],
    3: ["feature:champion"],
    5: ["feature:extra-attack"],
    9: ["feature:indomitable"],
    11: ["feature:extra-attack-2"],
    15: ["feature:superior-critical"],
    20: ["feature:extra-attack-3"],
  },
  multiclassRequires: [["str", "dex"]],
});

export const rogue = defineClass({
  id: "class:rogue",
  source,
  hitDie: 8,
  savingThrows: ["dex", "int"],
  skillChoices: ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight-of-hand", "stealth"],
  skillCount: 4,
  expertiseCount: 2,
  features: ["feature:sneak-attack", "feature:thieves-cant"],
  kits: [
    { id: "shadow", equipment: ["item:shortsword", "item:shortbow", "item:leather-armor"] },
    { id: "duelist", equipment: ["item:scimitar", "item:shortsword", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["dex", "cha", "int", "con", "wis", "str"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:cunning-action"], 3: ["feature:thief"], 5: ["feature:uncanny-dodge"], 7: ["feature:evasion"], 11: ["feature:reliable-talent"] },
  multiclassRequires: [["dex"]],
  multiclassSkillChoices: ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight-of-hand", "stealth"],
});

export const cleric = defineClass({
  id: "class:cleric",
  source,
  hitDie: 8,
  savingThrows: ["wis", "cha"],
  skillChoices: ["history", "insight", "medicine", "persuasion", "religion"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:disciple-of-life"],
  kits: [
    // The Life Domain grants heavy armor proficiency.
    { id: "shieldbearer", equipment: ["item:mace", "item:chain-mail", "item:shield"] },
    { id: "wayfarer", equipment: ["item:mace", "item:leather-armor", "item:shield", "item:javelin"] },
  ],
  // Bless and Cure Wounds are Life Domain spells, always prepared; the other
  // level 1 cleric spells the catalog has are prepared too (the limit,
  // Wisdom modifier plus level, is never below this many with the standard array).
  spellcasting: {
    ability: "wis",
    spells: ["spell:sacred-flame", "spell:thaumaturgy", "spell:bless", "spell:cure-wounds", "spell:healing-word", "spell:guiding-bolt"],
    slots: { 1: 2 },
  },
  suggested: ["wis", "con", "str", "cha", "dex", "int"],
  casterType: "full",
  spellcastingAbility: "wis",
  firstSpells: [],
  levelFeatures: { 2: ["feature:channel-divinity"], 5: ["feature:destroy-undead"] },
  multiclassRequires: [["wis"]],
  spellList: srd51ClericSpells,
});

export const barbarian = defineClass({
  id: "class:barbarian",
  source,
  hitDie: 12,
  savingThrows: ["str", "con"],
  skillChoices: ["animal-handling", "athletics", "intimidation", "nature", "perception", "survival"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:rage"],
  kits: [
    { id: "berserker", equipment: ["item:greataxe", "item:hide-armor"] },
    { id: "totemic", equipment: ["item:greataxe", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["str", "con", "dex", "wis", "cha", "int"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:reckless-attack", "feature:danger-sense"], 3: ["feature:path-of-the-berserker"], 5: ["feature:extra-attack", "feature:fast-movement"], 7: ["feature:feral-instinct"], 9: ["feature:brutal-critical"], 13: ["feature:brutal-critical-2"], 17: ["feature:brutal-critical-3"] },
  multiclassRequires: [["str"]],
});

export const bard = defineClass({
  id: "class:bard",
  source,
  hitDie: 8,
  savingThrows: ["dex", "cha"],
  skillChoices: [
    "acrobatics",
    "animal-handling",
    "arcana",
    "athletics",
    "deception",
    "history",
    "insight",
    "intimidation",
    "investigation",
    "medicine",
    "nature",
    "perception",
    "performance",
    "persuasion",
    "religion",
    "sleight-of-hand",
    "stealth",
    "survival",
  ],
  skillCount: 3,
  expertiseCount: 0,
  features: ["feature:bardic-inspiration"],
  kits: [
    { id: "lore", equipment: ["item:rapier", "item:leather-armor"] },
    { id: "skald", equipment: ["item:quarterstaff", "item:leather-armor"] },
  ],
  spellcasting: { ability: "cha", spells: ["spell:vicious-mockery", "spell:healing-word", "spell:bless", "spell:cure-wounds"], slots: { 1: 2 } },
  suggested: ["cha", "dex", "con", "wis", "int", "str"],
  casterType: "full",
  spellcastingAbility: "cha",
  firstSpells: [],
  levelFeatures: { 2: ["feature:jack-of-all-trades"], 3: ["feature:college-of-lore"], 5: ["feature:font-of-inspiration"] },
  multiclassRequires: [["cha"]],
  multiclassSkillChoices: [
    "acrobatics",
    "animal-handling",
    "arcana",
    "athletics",
    "deception",
    "history",
    "insight",
    "intimidation",
    "investigation",
    "medicine",
    "nature",
    "perception",
    "performance",
    "persuasion",
    "religion",
    "sleight-of-hand",
    "stealth",
    "survival",
  ],
  spellList: srd51BardSpells,
});

export const druid = defineClass({
  id: "class:druid",
  source,
  hitDie: 8,
  savingThrows: ["int", "wis"],
  skillChoices: ["arcana", "animal-handling", "insight", "medicine", "nature", "perception", "religion", "survival"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:druidic"],
  kits: [
    { id: "land", equipment: ["item:quarterstaff", "item:leather-armor", "item:shield"] },
    { id: "moonlit", equipment: ["item:scimitar", "item:leather-armor"] },
  ],
  spellcasting: { ability: "wis", spells: ["spell:produce-flame", "spell:cure-wounds", "spell:healing-word"], slots: { 1: 2 } },
  suggested: ["wis", "con", "dex", "int", "cha", "str"],
  casterType: "full",
  spellcastingAbility: "wis",
  firstSpells: [],
  levelFeatures: { 2: ["feature:wild-shape"], 3: ["feature:circle-of-the-land"] },
  multiclassRequires: [["wis"]],
  spellList: srd51DruidSpells,
});

export const monk = defineClass({
  id: "class:monk",
  source,
  hitDie: 8,
  savingThrows: ["str", "dex"],
  skillChoices: ["acrobatics", "athletics", "history", "insight", "religion", "stealth"],
  skillCount: 2,
  expertiseCount: 0,
  // No armor and no shield: Unarmored Defense is out of scope for the
  // starter roster (it would need a base-AC formula per class, not just
  // per item), so a monk's AC is 10 + Dex, as if unarmed and unarmored.
  features: ["feature:martial-arts"],
  kits: [
    { id: "openhand", equipment: ["item:shortsword"] },
    { id: "umbra", equipment: ["item:dagger"] },
  ],
  spellcasting: null,
  suggested: ["dex", "wis", "con", "str", "cha", "int"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:ki", "feature:unarmored-movement", "feature:flurry-of-blows", "feature:patient-defense", "feature:step-of-the-wind"], 3: ["feature:way-of-the-open-hand"], 5: ["feature:extra-attack"], 6: ["feature:unarmored-movement-6"], 7: ["feature:evasion"], 10: ["feature:purity-of-body", "feature:unarmored-movement-10"], 14: ["feature:unarmored-movement-14"], 18: ["feature:unarmored-movement-18"] },
  multiclassRequires: [["dex"], ["wis"]],
});

export const paladin = defineClass({
  id: "class:paladin",
  source,
  hitDie: 10,
  savingThrows: ["wis", "cha"],
  skillChoices: ["athletics", "insight", "intimidation", "medicine", "persuasion", "religion"],
  skillCount: 2,
  expertiseCount: 0,
  // No spellcasting: paladin spells begin at level 2 in the SRD.
  features: ["feature:divine-sense", "feature:lay-on-hands"],
  kits: [
    { id: "oath", equipment: ["item:longsword", "item:chain-mail", "item:shield"] },
    { id: "vengeance", equipment: ["item:longsword", "item:leather-armor", "item:javelin"] },
  ],
  spellcasting: null,
  suggested: ["str", "cha", "con", "wis", "dex", "int"],
  casterType: "half",
  spellcastingAbility: "cha",
  // Approximated from the shared catalog's small spell list rather than the
  // class's own full SRD list, the same liberty the level-1 roster already
  // takes for Bard and Warlock.
  firstSpells: ["spell:cure-wounds", "spell:bless"],
  levelFeatures: { 2: ["feature:fighting-style-dueling", "feature:divine-smite"], 3: ["feature:oath-of-devotion"], 5: ["feature:extra-attack"], 6: ["feature:aura-of-protection"], 10: ["feature:aura-of-courage"], 11: ["feature:improved-divine-smite"] },
  multiclassRequires: [["str"], ["cha"]],
  spellList: srd51PaladinSpells,
});

export const ranger = defineClass({
  id: "class:ranger",
  source,
  hitDie: 10,
  savingThrows: ["str", "dex"],
  skillChoices: ["animal-handling", "athletics", "insight", "investigation", "nature", "perception", "stealth", "survival"],
  skillCount: 3,
  expertiseCount: 0,
  // No spellcasting: ranger spells begin at level 2 in the SRD.
  features: ["feature:favored-enemy", "feature:natural-explorer"],
  kits: [
    { id: "hunter", equipment: ["item:longbow", "item:leather-armor"] },
    { id: "beastmaster", equipment: ["item:shortbow", "item:scimitar", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["dex", "wis", "con", "str", "cha", "int"],
  casterType: "half",
  spellcastingAbility: "wis",
  firstSpells: ["spell:cure-wounds"],
  levelFeatures: { 2: ["feature:fighting-style-dueling"], 3: ["feature:hunter"], 5: ["feature:extra-attack"] },
  multiclassRequires: [["dex"], ["wis"]],
  multiclassSkillChoices: ["animal-handling", "athletics", "insight", "investigation", "nature", "perception", "stealth", "survival"],
  spellList: srd51RangerSpells,
});

export const sorcerer = defineClass({
  id: "class:sorcerer",
  source,
  hitDie: 6,
  savingThrows: ["con", "cha"],
  skillChoices: ["arcana", "deception", "insight", "intimidation", "persuasion", "religion"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:draconic-bloodline"],
  kits: [
    { id: "wildmagic", equipment: ["item:dagger"] },
    { id: "draconic", equipment: ["item:quarterstaff"] },
  ],
  spellcasting: { ability: "cha", spells: ["spell:fire-bolt", "spell:magic-missile", "spell:shield"], slots: { 1: 2 } },
  suggested: ["cha", "con", "dex", "wis", "int", "str"],
  casterType: "full",
  spellcastingAbility: "cha",
  firstSpells: [],
  levelFeatures: { 2: ["feature:font-of-magic"], 3: ["feature:metamagic", "feature:quickened-spell", "feature:twinned-spell"] },
  multiclassRequires: [["cha"]],
  spellList: srd51SorcererSpells,
});

export const warlock = defineClass({
  id: "class:warlock",
  source,
  hitDie: 8,
  savingThrows: ["wis", "cha"],
  skillChoices: ["arcana", "deception", "history", "intimidation", "investigation", "nature", "religion"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:fiend-patron"],
  kits: [
    { id: "fiendpact", equipment: ["item:dagger", "item:leather-armor"] },
    { id: "oldone", equipment: ["item:quarterstaff", "item:leather-armor"] },
  ],
  // Pact Magic: fewer, always-highest-level slots. One slot at level 1.
  spellcasting: { ability: "cha", spells: ["spell:eldritch-blast", "spell:witch-bolt"], slots: { 1: 1 } },
  suggested: ["cha", "con", "dex", "wis", "int", "str"],
  casterType: "pact",
  spellcastingAbility: "cha",
  firstSpells: [],
  levelFeatures: { 2: ["feature:eldritch-invocations", "feature:agonizing-blast", "feature:armor-of-shadows", "feature:fiendish-vigor"], 3: ["feature:pact-boon"] },
  multiclassRequires: [["cha"]],
  spellList: srd51WarlockSpells,
});

export const wizard = defineClass({
  id: "class:wizard",
  source,
  hitDie: 6,
  savingThrows: ["int", "wis"],
  skillChoices: ["arcana", "history", "insight", "investigation", "medicine", "religion"],
  skillCount: 2,
  expertiseCount: 0,
  features: ["feature:arcane-recovery"],
  kits: [
    { id: "scholar", equipment: ["item:dagger", "item:quarterstaff"] },
    { id: "evoker", equipment: ["item:dagger"] },
  ],
  // A Wizard's classic utility repertoire, so the outside-combat spellcasting
  // step (engine/utility-magic.ts) has a caster who actually knows any of it
  // out of the box; a deliberate simplification, not the full SRD wizard
  // spell list, and not yet sprinkled onto every other caster class.
  spellcasting: {
    ability: "int",
    spells: ["spell:fire-bolt", "spell:magic-missile", "spell:shield", "spell:mage-hand", "spell:prestidigitation", "spell:detect-magic", "spell:identify", "spell:comprehend-languages"],
    slots: { 1: 2 },
  },
  suggested: ["int", "con", "dex", "wis", "cha", "str"],
  casterType: "full",
  spellcastingAbility: "int",
  firstSpells: [],
  levelFeatures: { 2: ["feature:school-of-evocation"] },
  multiclassRequires: [["int"]],
  spellList: srd51WizardSpells,
});

export const srd51Classes: readonly ClassDefinition[] = [fighter, rogue, cleric, barbarian, bard, druid, monk, paladin, ranger, sorcerer, warlock, wizard];
