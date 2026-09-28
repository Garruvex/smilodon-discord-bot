import { describe, expect, it } from "vitest";

import {
  buildClasses,
  buildProblems,
  classTemplates,
  deriveSheet,
  kitEquipment,
  standardArray,
  suggestedAbilities,
  type BuildChoices,
} from "../../../src/domain/campaign/character/character-build.js";
import { abilities } from "../../../src/domain/campaign/rules/effects.js";
import { defaultHeroResources, heroCombatant } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { ruleset } from "./campaign-fixtures.js";

const fighter: BuildChoices = {
  class: "fighter",
  kit: "knight",
  abilities: { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 },
  skills: ["athletics", "perception"],
  expertise: [],
  name: "Aldric",
  appearance: "Broad, scarred, kind eyes.",
  backstory: "A former town guard.",
};
const rogue: BuildChoices = {
  class: "rogue",
  kit: "shadow",
  abilities: { str: 8, dex: 15, con: 13, int: 12, wis: 10, cha: 14 },
  skills: ["stealth", "perception", "acrobatics", "deception"],
  expertise: ["stealth", "perception"],
  name: "Wren",
  appearance: "",
  backstory: "",
};
const cleric: BuildChoices = {
  class: "cleric",
  kit: "shieldbearer",
  abilities: { str: 12, dex: 10, con: 13, int: 8, wis: 15, cha: 14 },
  skills: ["insight", "medicine"],
  expertise: [],
  name: "Sister Odile",
  appearance: "",
  backstory: "",
};

describe("the guided builder", () => {
  it("accepts a legal build for every class, and derives the numbers from it", () => {
    for (const build of [fighter, rogue, cleric]) expect(buildProblems(build)).toEqual([]);
    // Hit points: the Hit Die at level 1 plus the Constitution modifier.
    expect(deriveSheet(fighter)).toMatchObject({ maxHp: 12, hitDie: 10, proficiencyBonus: 2, level: 1, savingThrows: ["str", "con"], className: "fighter" });
    expect(deriveSheet(rogue)).toMatchObject({ maxHp: 9, hitDie: 8, skills: { stealth: "expertise", perception: "expertise", acrobatics: "proficient", deception: "proficient" } });
    expect(deriveSheet(cleric)).toMatchObject({ maxHp: 9, spellcasting: { ability: "wis", slots: { 1: 2 } } });
    expect(deriveSheet(fighter).equipment).toEqual(["item:longsword", "item:chain-mail", "item:shield"]);
    expect(kitEquipment({ class: "rogue", kit: "duelist" })).toEqual(["item:scimitar", "item:shortsword", "item:leather-armor"]);
  });

  it("has only content the ruleset actually has, so no sheet can name something missing", () => {
    const { content } = ruleset();
    for (const buildClass of buildClasses) {
      const template = classTemplates[buildClass];
      for (const id of template.features) expect(content.find(id)?.kind, id).toBe("feature");
      for (const id of template.spellcasting?.spells ?? []) expect(content.find(id)?.kind, id).toBe("spell");
      for (const kit of template.kits) for (const id of kit.equipment) expect(content.find(id)?.kind, id).toBe("item");
    }
  });

  it("makes a sheet the engine can turn into a combatant, with the armor class the kit gives", () => {
    const { content } = ruleset();
    const sheet = { ...deriveSheet(fighter), id: "c-aldric", ownerUserId: "u-1" };
    const combatant = heroCombatant(sheet, content, "gate", { hp: sheet.maxHp, resources: defaultHeroResources(sheet, content) });
    // Chain mail 16 + shield 2.
    expect(combatant.armorClass).toBe(18);
    expect(combatant.maxHp).toBe(12);
    const light = { ...deriveSheet(rogue), id: "c-wren", ownerUserId: "u-2" };
    // Leather 11 + Dex 2.
    expect(heroCombatant(light, content, "gate", { hp: light.maxHp, resources: defaultHeroResources(light, content) }).armorClass).toBe(13);
  });

  it("suggests a standard-array assignment for each class that is itself legal", () => {
    for (const buildClass of buildClasses) {
      const suggestion = suggestedAbilities(buildClass);
      expect(abilities.map((ability) => suggestion[ability]).sort((a, b) => b - a)).toEqual([...standardArray]);
    }
    expect(suggestedAbilities("rogue").dex).toBe(15);
    expect(suggestedAbilities("cleric").wis).toBe(15);
  });

  it("says exactly what is wrong with an illegal build", () => {
    expect(buildProblems({ ...fighter, abilities: { ...fighter.abilities, str: 18 } })).toEqual([{ code: "abilitiesNotStandardArray" }]);
    expect(buildProblems({ ...fighter, abilities: { str: 15, dex: 15, con: 14, int: 8, wis: 13, cha: 10 } })).toEqual([{ code: "abilitiesNotStandardArray" }]);
    expect(buildProblems({ ...fighter, kit: "wizard" })).toEqual([{ code: "unknownKit", kit: "wizard" }]);
    expect(buildProblems({ ...fighter, skills: ["athletics"] })).toEqual([{ code: "skillCount", expected: 2 }]);
    expect(buildProblems({ ...fighter, skills: ["athletics", "stealth"] })).toEqual([{ code: "skillNotAllowed", skill: "stealth" }]);
    expect(buildProblems({ ...fighter, skills: ["athletics", "athletics"] })).toEqual([{ code: "skillRepeated", skill: "athletics" }]);
    expect(buildProblems({ ...fighter, expertise: ["athletics", "perception"] })).toEqual([{ code: "expertiseCount", expected: 0 }]);
    expect(buildProblems({ ...rogue, expertise: ["stealth", "survival"] })).toEqual([{ code: "expertiseNotProficient", skill: "survival" }]);
    expect(buildProblems({ ...rogue, expertise: ["stealth"] })).toEqual([{ code: "expertiseCount", expected: 2 }]);
    expect(buildProblems({ ...fighter, name: "   " })).toEqual([{ code: "badName" }]);
    expect(buildProblems({ ...fighter, backstory: "x".repeat(301) })).toEqual([{ code: "textTooLong" }]);
    expect(buildProblems({ ...fighter, class: "artificer" as never })).toEqual([{ code: "unknownClass" }]);
  });

  it("trims the name and keeps the player's words out of the numbers", () => {
    expect(deriveSheet({ ...fighter, name: "  Aldric  " }).name).toBe("Aldric");
    // The sheet has no field for the appearance or backstory.
    expect(JSON.stringify(deriveSheet(fighter))).not.toContain("town guard");
  });

  it("is legal without a race, the same as before races existed", () => {
    expect(buildProblems(fighter)).toEqual([]);
    expect(deriveSheet(fighter).race).toBeUndefined();
    expect(deriveSheet(fighter).speed).toBe(30);
  });

  it("folds a chosen race's ability score increase and speed into the sheet, and its traits into combat", () => {
    const dwarfFighter: BuildChoices = { ...fighter, race: "dwarf" };
    expect(buildProblems(dwarfFighter)).toEqual([]);
    const sheet = deriveSheet(dwarfFighter);
    // Base Constitution 14 + Dwarf's +2.
    expect(sheet.abilityScores.con).toBe(16);
    expect(sheet.abilityScores.str).toBe(15); // Untouched abilities carry over unchanged.
    expect(sheet.speed).toBe(25);
    expect(sheet.race).toBe("race:dwarf");
    // Hit points follow the boosted Constitution: 10 (Hit Die) + 3 (Con +3 now).
    expect(sheet.maxHp).toBe(13);

    const { content } = ruleset();
    const dwarfSheet = { ...sheet, id: "c-dwarf", ownerUserId: "u-1" };
    const combatant = heroCombatant(dwarfSheet, content, "gate", { hp: dwarfSheet.maxHp, resources: defaultHeroResources(dwarfSheet, content) });
    expect(combatant.traits).toContainEqual({ kind: "damageResistance", damageTypes: ["poison"] });
    expect(combatant.speed).toBe(25);
  });

  it("rejects a build naming a race that does not exist", () => {
    expect(buildProblems({ ...fighter, race: "elemental" as never })).toEqual([{ code: "unknownRace" }]);
  });
});
