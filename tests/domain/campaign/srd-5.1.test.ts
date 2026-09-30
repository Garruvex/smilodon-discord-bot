import { describe, expect, it } from "vitest";

import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { cantripDiceCount } from "../../../src/domain/campaign/content/srd-5.1/spells/cantrips.js";
import { buildSrd51 } from "../../../src/domain/campaign/content/srd-5.1/index.js";
import { formatDiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import { milestone0Capabilities } from "../../../src/domain/campaign/rules/capabilities.js";
import { traitsOf } from "../../../src/domain/campaign/rules/content-definitions.js";
import type { Effect } from "../../../src/domain/campaign/rules/effects.js";

const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });

function amountOf(effect: Effect | undefined): string {
  if (effect?.kind === "heal" || effect?.kind === "damage") return formatDiceExpression(effect.amount);
  throw new Error(`Expected a heal or damage effect, got ${effect?.kind}.`);
}

describe("SRD 5.1 content", () => {
  it("builds with complete en and zh-TW glossaries against the milestone 0 capabilities", () => {
    expect(content.rulesetId).toBe("srd-5.1");
    expect(content.all("spell").length).toBeGreaterThan(0);
  });

  it("makes Unconscious include Incapacitated and Prone", () => {
    expect(content.get("condition:unconscious").includes).toEqual(["condition:incapacitated", "condition:prone"]);
  });

  it("scales Cure Wounds by slot level and adds the spellcasting modifier", () => {
    const cureWounds = content.get("spell:cure-wounds");
    expect(amountOf(cureWounds.plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 }).onLand[0])).toBe("1d8 + 3");
    expect(amountOf(cureWounds.plan({ slotLevel: 3, casterLevel: 5, spellcastingModifier: 3 }).onLand[0])).toBe("3d8 + 3");
  });

  it("makes Healing Word a bonus action at 60 feet", () => {
    const healingWord = content.get("spell:healing-word");
    expect(healingWord.castingTime).toBe("bonus-action");
    expect(healingWord.range).toEqual({ kind: "feet", feet: 60 });
    expect(amountOf(healingWord.plan({ slotLevel: 2, casterLevel: 3, spellcastingModifier: 2 }).onLand[0])).toBe("2d4 + 2");
  });

  it("makes Bless a concentration spell adding 1d4 to attacks and saves", () => {
    const bless = content.get("spell:bless");
    expect(bless.concentration).toBe(true);
    expect(bless.targeting).toEqual({ relation: "creature", count: 3, countPerHigherSlot: 1 });
    expect(bless.plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 }).onLand[0]).toMatchObject({
      kind: "bonusDie",
      appliesTo: ["attack", "save"],
      duration: { kind: "rounds", count: 10 },
    });
  });

  it("makes Sacred Flame a Dexterity save that scales at levels 5, 11, and 17", () => {
    const sacredFlame = content.get("spell:sacred-flame");
    const plan = sacredFlame.plan({ slotLevel: 0, casterLevel: 1, spellcastingModifier: 3 });
    expect(plan.check).toEqual({ kind: "savingThrow", ability: "dex" });
    expect(plan.onAvoid).toEqual([]);
    expect([1, 4, 5, 10, 11, 16, 17, 20].map(cantripDiceCount)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });


  it("scales Guiding Bolt by slot and marks the target for advantage", () => {
    const guidingBolt = content.get("spell:guiding-bolt");
    expect(guidingBolt.plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 })).toMatchObject({
      check: { kind: "spellAttack" },
      onLand: [{ kind: "damage", damageType: "radiant" }, { kind: "nextAttackAdvantage", target: "target" }],
    });
    expect(amountOf(guidingBolt.plan({ slotLevel: 2, casterLevel: 3, spellcastingModifier: 3 }).onLand[0])).toBe("5d6");
  });

  it("turns armor, shields, and features into the shared trait list", () => {
    expect(traitsOf(content.get("item:chain-mail"))).toEqual([{ kind: "armor", baseArmorClass: 16, dexterityCap: 0 }]);
    expect(traitsOf(content.get("item:shield"))).toEqual([{ kind: "armorClassBonus", amount: 2 }]);
    expect(traitsOf(content.get("feature:disciple-of-life"))).toEqual([{ kind: "healingBonus", flat: 2, perSpellLevel: 1 }]);
    expect(traitsOf(content.get("monster:wolf"))).toContainEqual({ kind: "packTactics" });
  });

  it("gives the wolf's bite a prone rider that references a real condition", () => {
    expect(content.get("monster:wolf").attacks[0]?.onHit).toEqual([
      { kind: "conditionUnlessSave", target: "target", ability: "str", dc: 11, condition: "condition:prone" },
    ]);
  });

  it("gives Paralyzed and Stunned the incapacitated/no-save/advantage-against shape, and Invisible the attack-roll swap", () => {
    expect(content.get("condition:paralyzed").includes).toEqual(["condition:incapacitated"]);
    expect(content.get("condition:paralyzed").modifiers).toContainEqual({ kind: "critsAgainst", reach: "within5" });
    expect(content.get("condition:stunned").includes).toEqual(["condition:incapacitated"]);
    expect(content.get("condition:invisible").modifiers).toEqual([
      { kind: "ownAttacks", mode: "advantage" },
      { kind: "attacksAgainst", mode: "disadvantage", reach: "any" },
    ]);
  });

  it("scales Ray of Frost and Chill Touch as attack-roll cantrips", () => {
    const rayOfFrost = content.get("spell:ray-of-frost");
    expect(rayOfFrost.plan({ slotLevel: 0, casterLevel: 5, spellcastingModifier: 3 })).toMatchObject({
      check: { kind: "spellAttack" },
      onLand: [{ kind: "damage", damageType: "cold" }],
    });
    expect(amountOf(rayOfFrost.plan({ slotLevel: 0, casterLevel: 5, spellcastingModifier: 3 }).onLand[0])).toBe("2d8");
    expect(content.get("spell:chill-touch").plan({ slotLevel: 0, casterLevel: 1, spellcastingModifier: 3 }).onLand[0]).toMatchObject({
      damageType: "necrotic",
    });
  });

  it("makes Command a Wisdom save that incapacitates for one round", () => {
    const command = content.get("spell:command");
    expect(command.plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 })).toEqual({
      check: { kind: "savingThrow", ability: "wis" },
      onLand: [{ kind: "applyCondition", target: "target", condition: "condition:incapacitated", duration: { kind: "rounds", count: 1 } }],
      onAvoid: [],
    });
  });

  it("gives the new monsters pack tactics or brute/skirmisher attacks that reference real weapons", () => {
    expect(traitsOf(content.get("monster:kobold"))).toContainEqual({ kind: "packTactics" });
    expect(traitsOf(content.get("monster:giant-rat"))).toContainEqual({ kind: "packTactics" });
    expect(content.get("monster:zombie").attacks[0]?.weapon).toBe("item:slam");
    expect(content.get("monster:orc").attacks[0]?.weapon).toBe("item:greataxe");
    expect(content.get("monster:skeleton").attacks.map((attack) => attack.weapon)).toEqual(["item:shortsword", "item:shortbow"]);
  });

  it("makes Zombie and Skeleton immune to the poisoned condition itself, not just poison damage", () => {
    expect(traitsOf(content.get("monster:zombie"))).toContainEqual({ kind: "conditionImmunity", conditions: ["condition:poisoned"] });
    expect(traitsOf(content.get("monster:skeleton"))).toContainEqual({ kind: "conditionImmunity", conditions: ["condition:poisoned"] });
  });

  it("makes Poison Spray and Acid Splash Constitution/Dexterity saves, and Shocking Grasp an attack roll", () => {
    expect(content.get("spell:poison-spray").plan({ slotLevel: 0, casterLevel: 1, spellcastingModifier: 3 })).toMatchObject({
      check: { kind: "savingThrow", ability: "con" },
      onLand: [{ kind: "damage", damageType: "poison" }],
    });
    expect(content.get("spell:acid-splash").plan({ slotLevel: 0, casterLevel: 1, spellcastingModifier: 3 })).toMatchObject({
      check: { kind: "savingThrow", ability: "dex" },
      onLand: [{ kind: "damage", damageType: "acid" }],
    });
    expect(content.get("spell:shocking-grasp").plan({ slotLevel: 0, casterLevel: 1, spellcastingModifier: 3 })).toMatchObject({
      check: { kind: "spellAttack" },
      onLand: [{ kind: "damage", damageType: "lightning" }],
    });
  });

  it("scales Inflict Wounds by slot and makes Tasha's Hideous Laughter a Wisdom save into Incapacitated and Prone", () => {
    expect(amountOf(content.get("spell:inflict-wounds").plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 }).onLand[0])).toBe("3d10");
    expect(amountOf(content.get("spell:inflict-wounds").plan({ slotLevel: 3, casterLevel: 5, spellcastingModifier: 3 }).onLand[0])).toBe("5d10");
    const laughter = content.get("spell:tashas-hideous-laughter").plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 });
    expect(laughter.check).toEqual({ kind: "savingThrow", ability: "wis" });
    expect(laughter.onLand).toEqual([
      { kind: "applyCondition", target: "target", condition: "condition:incapacitated", duration: { kind: "rounds", count: 10 } },
      { kind: "applyCondition", target: "target", condition: "condition:prone", duration: { kind: "rounds", count: 10 } },
    ]);
  });

  it("registers the full class and race roster as validated, glossaried content", () => {
    expect(content.all("class").map((definition) => definition.id).sort()).toEqual(
      [
        "class:barbarian",
        "class:bard",
        "class:cleric",
        "class:druid",
        "class:fighter",
        "class:monk",
        "class:paladin",
        "class:ranger",
        "class:rogue",
        "class:sorcerer",
        "class:warlock",
        "class:wizard",
      ].sort(),
    );
    expect(content.all("race").map((definition) => definition.id).sort()).toEqual(
      ["race:human", "race:elf", "race:dwarf", "race:halfling", "race:dragonborn", "race:gnome", "race:half-elf", "race:half-orc", "race:tiefling", "race:hill-dwarf", "race:mountain-dwarf", "race:high-elf", "race:wood-elf", "race:drow", "race:lightfoot-halfling", "race:stout-halfling", "race:forest-gnome", "race:rock-gnome", ...["black", "blue", "brass", "bronze", "copper", "gold", "green", "red", "silver", "white"].map((color) => `race:${color}-dragonborn`)].sort(),
    );
    expect(content.get("class:wizard").casterType).toBe("full");
    expect(content.get("class:paladin").spellcastingAbility).toBe("cha");
  });

  it("gives every class its own named subclass, mechanical where the engine already can", () => {
    expect(traitsOf(content.get("feature:champion"))).toEqual([{ kind: "expandedCritRange", threshold: 19 }]);
    expect(traitsOf(content.get("feature:draconic-bloodline"))).toEqual([{ kind: "damageResistance", damageTypes: ["fire"] }, { kind: "unarmoredBonus", amount: 3 }]);
    // Fiend Patron and the rest are narrative, same treatment as Thieves' Cant.
    expect(traitsOf(content.get("feature:fiend-patron"))).toEqual([]);
    expect(content.get("class:fighter").levelFeatures[3]).toEqual(["feature:champion"]);
    expect(content.get("class:sorcerer").features).toEqual(["feature:hide", "feature:escape-grapple", "feature:draconic-bloodline"]);
  });

  it("gives Dwarf, Dragonborn, and Tiefling a real damage resistance trait, and Elf just its ability bonus", () => {
    expect(traitsOf(content.get("race:dwarf"))).toContainEqual({ kind: "damageResistance", damageTypes: ["poison"] });
    expect(traitsOf(content.get("race:dragonborn"))).toContainEqual({ kind: "damageResistance", damageTypes: ["fire"] });
    expect(traitsOf(content.get("race:tiefling"))).toContainEqual({ kind: "damageResistance", damageTypes: ["fire"] });
    expect(content.get("race:elf").abilityScoreIncrease).toEqual({ dex: 2 });
    expect(content.get("race:elf").speed).toBe(30);
    expect(content.get("race:dwarf").speed).toBe(25);
  });

  it("gives Hobgoblin, Ogre, and Specter their weapons and Specter its heavy resistance/immunity list", () => {
    expect(content.get("monster:hobgoblin").attacks[0]?.weapon).toBe("item:longsword");
    expect(content.get("monster:ogre").attacks[0]?.weapon).toBe("item:greatclub");
    expect(content.get("monster:specter").attacks[0]?.weapon).toBe("item:life-drain");
    expect(traitsOf(content.get("monster:specter"))).toContainEqual({ kind: "damageImmunity", damageTypes: ["necrotic", "poison"] });
    const conditionImmunity = traitsOf(content.get("monster:specter")).find((trait) => trait.kind === "conditionImmunity");
    expect(conditionImmunity?.kind === "conditionImmunity" ? conditionImmunity.conditions : []).toEqual(
      expect.arrayContaining(["condition:charmed", "condition:paralyzed"]),
    );
  });
});
