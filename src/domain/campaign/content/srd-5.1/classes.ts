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
  features: ["feature:hide", "feature:fighting-style-dueling", "feature:second-wind", "feature:grapple", "feature:shove"],
  kits: [
    { id: "knight", equipment: ["item:longsword", "item:chain-mail", "item:shield"] },
    { id: "skirmisher", equipment: ["item:scimitar", "item:shortbow", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["str", "con", "dex", "wis", "int", "cha"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:action-surge"], 3: ["feature:champion"], 5: ["feature:extra-attack"], 9: ["feature:indomitable"], 10: ["feature:additional-fighting-style"], 11: ["feature:extra-attack-2"], 15: ["feature:superior-critical"], 18: ["feature:survivor"], 20: ["feature:extra-attack-3"] },
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
  features: ["feature:hide", "feature:sneak-attack", "feature:thieves-cant", "feature:grapple", "feature:shove"],
  kits: [
    { id: "shadow", equipment: ["item:shortsword", "item:shortbow", "item:leather-armor"] },
    { id: "duelist", equipment: ["item:scimitar", "item:shortsword", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["dex", "cha", "int", "con", "wis", "str"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:cunning-action"], 3: ["feature:thief", "feature:fast-hands", "feature:second-story-work"], 5: ["feature:uncanny-dodge"], 7: ["feature:evasion"], 9: ["feature:supreme-sneak"], 11: ["feature:reliable-talent"], 13: ["feature:use-magic-device"], 14: ["feature:blindsense"], 15: ["feature:slippery-mind"], 17: ["feature:thiefs-reflexes"], 18: ["feature:elusive"], 20: ["feature:stroke-of-luck"] },
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
  features: ["feature:hide", "feature:disciple-of-life"],
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
  levelFeatures: { 2: ["feature:channel-divinity"], 5: ["feature:destroy-undead"], 6: ["feature:blessed-healer"], 8: ["feature:divine-strike"], 10: ["feature:divine-intervention"], 17: ["feature:supreme-healing"] },
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
  features: ["feature:hide", "feature:rage", "feature:grapple", "feature:shove"],
  kits: [
    { id: "berserker", equipment: ["item:greataxe", "item:hide-armor"] },
    { id: "totemic", equipment: ["item:greataxe", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["str", "con", "dex", "wis", "cha", "int"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:reckless-attack", "feature:danger-sense"], 3: ["feature:path-of-the-berserker"], 5: ["feature:extra-attack", "feature:fast-movement"], 6: ["feature:mindless-rage"], 7: ["feature:feral-instinct"], 9: ["feature:brutal-critical"], 10: ["feature:intimidating-presence"], 11: ["feature:relentless-rage"], 13: ["feature:brutal-critical-2"], 14: ["feature:retaliation"], 15: ["feature:persistent-rage"], 17: ["feature:brutal-critical-3"], 18: ["feature:indomitable-might"], 20: ["feature:primal-champion"] },
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
  features: ["feature:hide", "feature:bardic-inspiration"],
  kits: [
    { id: "lore", equipment: ["item:rapier", "item:leather-armor"] },
    { id: "skald", equipment: ["item:quarterstaff", "item:leather-armor"] },
  ],
  spellcasting: { ability: "cha", spells: ["spell:vicious-mockery", "spell:healing-word", "spell:bless", "spell:cure-wounds"], slots: { 1: 2 } },
  suggested: ["cha", "dex", "con", "wis", "int", "str"],
  casterType: "full",
  spellcastingAbility: "cha",
  firstSpells: [],
  levelFeatures: { 2: ["feature:jack-of-all-trades", "feature:song-of-rest"], 3: ["feature:college-of-lore", "feature:cutting-words"], 5: ["feature:font-of-inspiration"], 6: ["feature:countercharm", "feature:additional-magical-secrets"], 10: ["feature:magical-secrets"], 14: ["feature:peerless-skill"], 20: ["feature:superior-inspiration"] },
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
  features: ["feature:hide", "feature:druidic"],
  kits: [
    { id: "land", equipment: ["item:quarterstaff", "item:leather-armor", "item:shield"] },
    { id: "moonlit", equipment: ["item:scimitar", "item:leather-armor"] },
  ],
  spellcasting: { ability: "wis", spells: ["spell:produce-flame", "spell:cure-wounds", "spell:healing-word"], slots: { 1: 2 } },
  suggested: ["wis", "con", "dex", "int", "cha", "str"],
  casterType: "full",
  spellcastingAbility: "wis",
  firstSpells: [],
  levelFeatures: { 2: ["feature:wild-shape"], 3: ["feature:circle-of-the-land"], 6: ["feature:lands-stride"], 10: ["feature:natures-ward"], 14: ["feature:natures-sanctuary"], 18: ["feature:timeless-body", "feature:beast-spells"], 20: ["feature:archdruid"] },
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
  features: ["feature:hide", "feature:martial-arts", "feature:grapple", "feature:shove"],
  kits: [
    { id: "openhand", equipment: ["item:shortsword"] },
    { id: "umbra", equipment: ["item:dagger"] },
  ],
  spellcasting: null,
  suggested: ["dex", "wis", "con", "str", "cha", "int"],
  casterType: "none",
  spellcastingAbility: null,
  firstSpells: [],
  levelFeatures: { 2: ["feature:ki", "feature:unarmored-movement", "feature:flurry-of-blows", "feature:patient-defense", "feature:step-of-the-wind"], 3: ["feature:way-of-the-open-hand", "feature:deflect-missiles", "feature:open-hand-technique"], 4: ["feature:slow-fall"], 5: ["feature:extra-attack", "feature:stunning-strike"], 6: ["feature:unarmored-movement-6", "feature:ki-empowered-strikes", "feature:wholeness-of-body"], 7: ["feature:evasion", "feature:stillness-of-mind"], 10: ["feature:purity-of-body", "feature:unarmored-movement-10"], 11: ["feature:tranquility"], 13: ["feature:tongue-of-the-sun-and-moon"], 14: ["feature:unarmored-movement-14", "feature:diamond-soul"], 15: ["feature:timeless-body-monk"], 17: ["feature:quivering-palm"], 18: ["feature:unarmored-movement-18", "feature:empty-body"], 20: ["feature:perfect-self"] },
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
  features: ["feature:hide", "feature:divine-sense", "feature:lay-on-hands", "feature:grapple", "feature:shove"],
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
  levelFeatures: { 2: ["feature:fighting-style-dueling", "feature:divine-smite"], 3: ["feature:oath-of-devotion", "feature:divine-health"], 5: ["feature:extra-attack"], 6: ["feature:aura-of-protection"], 7: ["feature:aura-of-devotion"], 10: ["feature:aura-of-courage"], 11: ["feature:improved-divine-smite"], 14: ["feature:cleansing-touch"], 15: ["feature:purity-of-heart"], 20: ["feature:holy-nimbus"] },
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
  features: ["feature:hide", "feature:favored-enemy", "feature:natural-explorer", "feature:grapple", "feature:shove"],
  kits: [
    { id: "hunter", equipment: ["item:longbow", "item:leather-armor"] },
    { id: "beastmaster", equipment: ["item:shortbow", "item:scimitar", "item:leather-armor"] },
  ],
  spellcasting: null,
  suggested: ["dex", "wis", "con", "str", "cha", "int"],
  casterType: "half",
  spellcastingAbility: "wis",
  firstSpells: ["spell:cure-wounds"],
  levelFeatures: { 2: ["feature:fighting-style-dueling"], 3: ["feature:hunter", "feature:primeval-awareness"], 5: ["feature:extra-attack"], 7: ["feature:defensive-tactics"], 8: ["feature:rangers-lands-stride"], 10: ["feature:hide-in-plain-sight"], 11: ["feature:hunter-multiattack"], 14: ["feature:vanish"], 15: ["feature:superior-hunters-defense"], 18: ["feature:feral-senses"], 20: ["feature:foe-slayer"] },
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
  features: ["feature:hide", "feature:draconic-bloodline"],
  kits: [
    { id: "wildmagic", equipment: ["item:dagger"] },
    { id: "draconic", equipment: ["item:quarterstaff"] },
  ],
  spellcasting: { ability: "cha", spells: ["spell:fire-bolt", "spell:magic-missile", "spell:shield"], slots: { 1: 2 } },
  suggested: ["cha", "con", "dex", "wis", "int", "str"],
  casterType: "full",
  spellcastingAbility: "cha",
  firstSpells: [],
  levelFeatures: { 2: ["feature:font-of-magic"], 3: ["feature:metamagic", "feature:quickened-spell", "feature:twinned-spell"], 6: ["feature:elemental-affinity"], 10: ["feature:metamagic-additional"], 14: ["feature:dragon-wings"], 18: ["feature:draconic-presence"], 20: ["feature:sorcerous-restoration"] },
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
  features: ["feature:hide", "feature:fiend-patron", "feature:dark-ones-blessing"],
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
  levelFeatures: { 2: ["feature:eldritch-invocations", "feature:agonizing-blast", "feature:armor-of-shadows", "feature:fiendish-vigor"], 3: ["feature:pact-boon"], 6: ["feature:dark-ones-own-luck"], 10: ["feature:fiendish-resilience"], 11: ["feature:mystic-arcanum-6"], 13: ["feature:mystic-arcanum-7"], 14: ["feature:hurl-through-hell"], 15: ["feature:mystic-arcanum-8"], 17: ["feature:mystic-arcanum-9"], 20: ["feature:eldritch-master"] },
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
  features: ["feature:hide", "feature:arcane-recovery"],
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
  levelFeatures: { 2: ["feature:school-of-evocation", "feature:sculpt-spells"], 6: ["feature:potent-cantrip"], 10: ["feature:empowered-evocation"], 14: ["feature:overchannel"], 18: ["feature:spell-mastery"], 20: ["feature:signature-spells"] },
  multiclassRequires: [["int"]],
  spellList: srd51WizardSpells,
});

export const srd51Classes: readonly ClassDefinition[] = [fighter, rogue, cleric, barbarian, bard, druid, monk, paladin, ranger, sorcerer, warlock, wizard];
