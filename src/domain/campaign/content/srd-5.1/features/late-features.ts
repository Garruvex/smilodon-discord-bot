import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Class features from level 6 up, and the subclass features that come with them (SRD 5.1, Classes).
// Most are named on the sheet only: they act outside a fight, or need a rule the engine does not have
// (docs/dnd-completion-roadmap.md). Those with a trait are read where that rule applies.
const source = "SRD 5.1";

const narrative = (name: string): FeatureDefinition => defineFeature({ id: `feature:${name}`, source, traits: [], action: null });

export const mindlessRage = narrative("mindless-rage");
export const intimidatingPresence = defineFeature({ id: "feature:intimidating-presence", source, traits: [{ kind: "featureSpell", spell: "spell:intimidating-presence", ability: "cha", uses: 1, recharge: "longRest" }], action: null });
export const retaliation = defineFeature({ id: "feature:retaliation", source, traits: [{ kind: "retaliation" }], action: null });
export const persistentRage = narrative("persistent-rage");
export const indomitableMight = defineFeature({ id: "feature:indomitable-might", source, traits: [{ kind: "indomitableMight" }], action: null });
export const primalChampion = narrative("primal-champion");
export const songOfRest = narrative("song-of-rest");
export const cuttingWords = defineFeature({ id: "feature:cutting-words", source, traits: [{ kind: "cuttingWords" }], action: null });
// The SRD asks for an action to start the performance; here it is always on while the bard can be heard.
export const countercharm = defineFeature({ id: "feature:countercharm", source, traits: [{ kind: "countercharm" }], action: null });
export const additionalMagicalSecrets = narrative("additional-magical-secrets");
export const magicalSecrets = narrative("magical-secrets");
export const peerlessSkill = narrative("peerless-skill");
export const superiorInspiration = defineFeature({ id: "feature:superior-inspiration", source, traits: [{ kind: "superiorInspiration" }], action: null });
export const blessedHealer = defineFeature({ id: "feature:blessed-healer", source, traits: [{ kind: "blessedHealer" }], action: null });
export const divineStrike = defineFeature({ id: "feature:divine-strike", source, traits: [{ kind: "divineStrike" }], action: null });
// The cleric implores their deity: a percentile roll at or under their level (always, at 20th) and the whole party is made whole.
// The SRD leaves the answer to the DM and holds the power back for a week after it works; here it is once per long rest.
export const divineIntervention = defineFeature({
  id: "feature:divine-intervention",
  source,
  traits: [],
  action: { cost: "action", uses: { count: 1, recharge: "longRest" }, plan: () => ({ check: null, onLand: [{ kind: "divineIntervention", target: "self" }], onAvoid: [] }) },
});
export const supremeHealing = defineFeature({ id: "feature:supreme-healing", source, traits: [{ kind: "supremeHealing" }], action: null });
export const landsStride = defineFeature({ id: "feature:lands-stride", source, traits: [{ kind: "landsStride" }], action: null });
// The SRD also shields the druid from charms and fears cast by elementals and fey; only the poison and disease part is played (no disease exists here).
export const naturesWard = defineFeature({ id: "feature:natures-ward", source, traits: [{ kind: "conditionImmunity", conditions: ["condition:poisoned"] }, { kind: "damageImmunity", damageTypes: ["poison"] }], action: null });
export const naturesSanctuary = narrative("natures-sanctuary");
export const timelessBody = narrative("timeless-body");
export const beastSpells = defineFeature({ id: "feature:beast-spells", source, traits: [{ kind: "beastSpells" }], action: null });
export const archdruid = defineFeature({ id: "feature:archdruid", source, traits: [{ kind: "unlimitedWildShape" }], action: null });
export const additionalFightingStyle = narrative("additional-fighting-style");
export const survivor = defineFeature({ id: "feature:survivor", source, traits: [{ kind: "survivor" }], action: null });
export const deflectMissiles = defineFeature({ id: "feature:deflect-missiles", source, traits: [{ kind: "deflectMissiles" }], action: null });
export const openHandTechnique = narrative("open-hand-technique");
export const slowFall = narrative("slow-fall");
export const kiEmpoweredStrikes = narrative("ki-empowered-strikes");
export const wholenessOfBody = defineFeature({ id: "feature:wholeness-of-body", source, traits: [{ kind: "featureSpell", spell: "spell:wholeness-of-body", ability: "wis", uses: 1, recharge: "longRest" }], action: null });
// Ends charmed or frightened on the monk.
export const stillnessOfMind = defineFeature({
  id: "feature:stillness-of-mind",
  source,
  traits: [],
  action: { cost: "action", uses: { count: 99, recharge: "shortRest" }, plan: () => ({ check: null, onLand: [{ kind: "removeCondition", target: "self", conditions: ["condition:charmed", "condition:frightened"] }], onAvoid: [] }) },
});
export const tranquility = narrative("tranquility");
export const tongueOfTheSunAndMoon = narrative("tongue-of-the-sun-and-moon");
export const diamondSoul = narrative("diamond-soul");
export const timelessBodyMonk = narrative("timeless-body-monk");
// Three ki ready the palm for the next melee hit: the target makes a Constitution save or drops to 0 hit points, and takes 10d10 necrotic damage if it passes.
// The SRD lets the monk set the vibrations going and end them later; here they end at once.
export const quiveringPalm = defineFeature({
  id: "feature:quivering-palm",
  source,
  traits: [],
  action: { cost: "free", uses: { pool: "feature:ki" }, spend: 3, plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "quiveringPalm" }], duration: { kind: "rounds", count: 1 } }], onAvoid: [] }) },
});
// Four ki: invisible, and resistant to everything but force, for a minute.
export const emptyBody = defineFeature({
  id: "feature:empty-body",
  source,
  traits: [],
  action: {
    cost: "action",
    uses: { pool: "feature:ki" },
    spend: 4,
    plan: () => ({
      check: null,
      onLand: [
        { kind: "applyCondition", target: "self", condition: "condition:invisible", duration: { kind: "rounds", count: 10 } },
        { kind: "applyModifiers", target: "self", modifiers: [{ kind: "damageResistance", damageTypes: ["acid", "bludgeoning", "cold", "fire", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"] }], duration: { kind: "rounds", count: 10 } },
      ],
      onAvoid: [],
    }),
  },
});
export const perfectSelf = defineFeature({ id: "feature:perfect-self", source, traits: [{ kind: "perfectSelf" }], action: null });
export const divineHealth = narrative("divine-health");
export const auraOfDevotion = defineFeature({ id: "feature:aura-of-devotion", source, traits: [{ kind: "auraOfImmunity", conditions: ["condition:charmed"] }], action: null });
export const cleansingTouch = narrative("cleansing-touch");
export const purityOfHeart = narrative("purity-of-heart");
export const holyNimbus = defineFeature({ id: "feature:holy-nimbus", source, traits: [{ kind: "featureSpell", spell: "spell:holy-nimbus", ability: "cha", uses: 1, recharge: "longRest" }], action: null });
export const primevalAwareness = narrative("primeval-awareness");
export const defensiveTactics = narrative("defensive-tactics");
export const rangersLandsStride = defineFeature({ id: "feature:rangers-lands-stride", source, traits: [{ kind: "landsStride" }], action: null });
export const hideInPlainSight = narrative("hide-in-plain-sight");
export const hunterMultiattack = narrative("hunter-multiattack");
export const vanish = defineFeature({ id: "feature:vanish", source, traits: [{ kind: "quickHide" }], action: null });
export const superiorHuntersDefense = defineFeature({ id: "feature:superior-hunters-defense", source, traits: [{ kind: "hunterDefense" }], action: null });
export const feralSenses = narrative("feral-senses");
export const foeSlayer = defineFeature({ id: "feature:foe-slayer", source, traits: [{ kind: "foeSlayer" }], action: null });
export const fastHands = defineFeature({ id: "feature:fast-hands", source, traits: [{ kind: "fastHands" }], action: null });
export const secondStoryWork = narrative("second-story-work");
export const supremeSneak = narrative("supreme-sneak");
export const useMagicDevice = narrative("use-magic-device");
export const blindsense = narrative("blindsense");
export const slipperyMind = narrative("slippery-mind");
export const thiefsReflexes = narrative("thiefs-reflexes");
export const elusive = defineFeature({ id: "feature:elusive", source, traits: [{ kind: "elusive" }], action: null });
// A miss becomes a hit, once per short rest (a failed ability check is not covered).
export const strokeOfLuck = defineFeature({ id: "feature:stroke-of-luck", source, traits: [{ kind: "strokeOfLuck" }], action: null, resource: { count: 1, recharge: "shortRest" } });
// Every sorcerer here descends from a red dragon (draconic-bloodline), so the affinity is for fire.
export const elementalAffinity = defineFeature({ id: "feature:elemental-affinity", source, traits: [{ kind: "elementalAffinity", damageType: "fire" }], action: null });
export const metamagicAdditional = narrative("metamagic-additional");
// Sprouts wings and flies until the sorcerer is done (the SRD has a bonus action to dismiss them too, and no armor to wear over them: neither is modeled).
export const dragonWings = defineFeature({
  id: "feature:dragon-wings",
  source,
  traits: [],
  action: { cost: "bonusAction", uses: { count: 99, recharge: "shortRest" }, plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "flying" }], duration: { kind: "untilRemoved" } }], onAvoid: [] }) },
});
// Five sorcery points buy a frightening presence (the SRD lets the sorcerer choose charmed instead, and keeps the aura for a minute).
export const draconicPresence = defineFeature({ id: "feature:draconic-presence", source, traits: [{ kind: "featureSpell", spell: "spell:draconic-presence", ability: "cha", uses: 1, recharge: "longRest", pool: "feature:font-of-magic", cost: 5 }], action: null });
export const sorcerousRestoration = narrative("sorcerous-restoration");
export const darkOnesBlessing = defineFeature({ id: "feature:dark-ones-blessing", source, traits: [{ kind: "darkOnesBlessing" }], action: null });
export const darkOnesOwnLuck = narrative("dark-ones-own-luck");
export const fiendishResilience = narrative("fiendish-resilience");
// One free casting of a high spell each per long rest. This build fixes which spell: the SRD has the warlock choose.
const arcanum = (level: number, spell: `spell:${string}`): FeatureDefinition => defineFeature({ id: `feature:mystic-arcanum-${level}`, source, traits: [{ kind: "featureSpell", spell, ability: "cha", uses: 1, recharge: "longRest" }], action: null });
export const mysticArcanum6 = arcanum(6, "spell:circle-of-death");
export const mysticArcanum7 = arcanum(7, "spell:finger-of-death");
// Readies the next hit to send its target through the lower planes: 10d10 psychic damage (a fiend takes none), and it is gone from the fight for a round.
export const hurlThroughHell = defineFeature({
  id: "feature:hurl-through-hell",
  source,
  traits: [],
  action: { cost: "free", uses: { count: 1, recharge: "longRest" }, plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "hurlThroughHell" }], duration: { kind: "rounds", count: 1 } }], onAvoid: [] }) },
});
export const mysticArcanum8 = arcanum(8, "spell:power-word-stun");
export const mysticArcanum9 = arcanum(9, "spell:power-word-kill");
export const eldritchMaster = narrative("eldritch-master");
export const sculptSpells = defineFeature({ id: "feature:sculpt-spells", source, traits: [{ kind: "sculptSpells" }], action: null });
export const potentCantrip = defineFeature({ id: "feature:potent-cantrip", source, traits: [{ kind: "potentCantrip" }], action: null });
export const empoweredEvocation = defineFeature({ id: "feature:empowered-evocation", source, traits: [{ kind: "empoweredEvocation" }], action: null });
// Readies the next spell of the 1st to 5th level to deal its maximum (used up by the casting). The SRD's damage to the wizard for later uses is not modeled: it is once per long rest.
export const overchannel = defineFeature({
  id: "feature:overchannel",
  source,
  traits: [],
  action: {
    cost: "free",
    uses: { count: 1, recharge: "longRest" },
    plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "overchannel" }], duration: { kind: "rounds", count: 1 } }], onAvoid: [] }),
  },
});
// The wizard picks one 1st- and one 2nd-level spell to cast at will; this build fixes them (Magic Missile and Misty Step).
export const spellMastery = defineFeature({
  id: "feature:spell-mastery",
  source,
  traits: [
    { kind: "featureSpell", spell: "spell:magic-missile", ability: "int", uses: null, recharge: "never" },
    { kind: "featureSpell", spell: "spell:misty-step", ability: "int", uses: null, recharge: "never" },
  ],
  action: null,
});
// Two 3rd-level spells once per short rest each, without a slot; this build fixes them (Fireball and Fly).
export const signatureSpells = defineFeature({
  id: "feature:signature-spells",
  source,
  traits: [
    { kind: "featureSpell", spell: "spell:fireball", ability: "int", uses: 1, recharge: "shortRest" },
    { kind: "featureSpell", spell: "spell:fly", ability: "int", uses: 1, recharge: "shortRest" },
  ],
  action: null,
});

export const srd51LateFeatures: readonly FeatureDefinition[] = [mindlessRage, intimidatingPresence, retaliation, persistentRage, indomitableMight, primalChampion, songOfRest, cuttingWords, countercharm, additionalMagicalSecrets, magicalSecrets, peerlessSkill, superiorInspiration, blessedHealer, divineStrike, divineIntervention, supremeHealing, landsStride, naturesWard, naturesSanctuary, timelessBody, beastSpells, archdruid, additionalFightingStyle, survivor, deflectMissiles, openHandTechnique, slowFall, kiEmpoweredStrikes, wholenessOfBody, stillnessOfMind, tranquility, tongueOfTheSunAndMoon, diamondSoul, timelessBodyMonk, quiveringPalm, emptyBody, perfectSelf, divineHealth, auraOfDevotion, cleansingTouch, purityOfHeart, holyNimbus, primevalAwareness, defensiveTactics, rangersLandsStride, hideInPlainSight, hunterMultiattack, vanish, superiorHuntersDefense, feralSenses, foeSlayer, fastHands, secondStoryWork, supremeSneak, useMagicDevice, blindsense, slipperyMind, thiefsReflexes, elusive, strokeOfLuck, elementalAffinity, metamagicAdditional, dragonWings, draconicPresence, sorcerousRestoration, darkOnesBlessing, darkOnesOwnLuck, fiendishResilience, mysticArcanum6, mysticArcanum7, hurlThroughHell, mysticArcanum8, mysticArcanum9, eldritchMaster, sculptSpells, potentCantrip, empoweredEvocation, overchannel, spellMastery, signatureSpells];
