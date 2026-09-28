import { describe, expect, it } from "vitest";

import { canMulticlassInto, deriveSheet, hitDicePool, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { levelUp, spellSlotsForLevel } from "../../../src/domain/campaign/character/leveling.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign, jamie, run, reject } from "./campaign-fixtures.js";

const fighterBuild: BuildChoices = {
  class: "fighter",
  kit: "knight",
  abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 13, cha: 10 },
  skills: ["athletics", "history"],
  expertise: [],
  name: "Torvin",
  appearance: "",
  backstory: "",
};

function sheetWith(id: string, ownerUserId: string, over: Partial<ReturnType<typeof deriveSheet>> = {}): CharacterSheet {
  return { ...deriveSheet(fighterBuild), ...over, id: id, ownerUserId: ownerUserId };
}

describe("multiclassing prerequisites", () => {
  it("exempts a class the hero already holds levels in", () => {
    const sheet = sheetWith("c-1", "u-1");
    expect(canMulticlassInto("fighter", sheet)).toBe(true);
  });

  it("gates a brand-new class on its SRD ability-score requirement (13+)", () => {
    // Torvin's Int is 8, well under Wizard's required 13; his Wis is exactly
    // Cleric's required 13.
    const sheet = sheetWith("c-1", "u-1");
    expect(canMulticlassInto("wizard", sheet)).toBe(false);
    expect(canMulticlassInto("cleric", sheet)).toBe(true);
  });

  it("accepts an ability-group requirement satisfied by any one ability in it (Fighter's Str-or-Dex)", () => {
    const dexterous = sheetWith("c-1", "u-1", { abilityScores: { str: 8, dex: 15, con: 10, int: 10, wis: 10, cha: 10 } });
    expect(canMulticlassInto("fighter", dexterous)).toBe(true);
  });
});

describe("levelUp: taking a level in a brand-new class", () => {
  it("gains HP off the new class's own Hit Die, not the hero's first class's", () => {
    const sheet = sheetWith("c-1", "u-1", { level: 3, classLevels: { fighter: 3 }, maxHp: 30 });
    const next = levelUp(sheet, "wizard");
    // Wizard's d6 average (3) + Con mod (14 -> +2) = 6; Fighter's own d10 would have given 8.
    expect(next.maxHp - sheet.maxHp).toBe(6);
    expect(next.classLevels).toEqual({ fighter: 3, wizard: 1 });
    expect(next.level).toBe(4);
  });

  it("grants the new class's own level-1 features on the first level taken in it, not just levelFeatures", () => {
    const sheet = sheetWith("c-1", "u-1", { level: 1, classLevels: { fighter: 1 } });
    const next = levelUp(sheet, "wizard");
    expect(next.features).toEqual(expect.arrayContaining(["feature:arcane-recovery"]));
  });

  it("grants a Rogue's one multiclass skill on the first Rogue level, and only then", () => {
    const sheet = sheetWith("c-1", "u-1", { level: 1, classLevels: { fighter: 1 }, skills: {} });
    const first = levelUp(sheet, "rogue", "stealth");
    expect(first.skills.stealth).toBe("proficient");
    const withRogue = { ...sheet, ...first, classLevels: first.classLevels, skills: first.skills };
    const second = levelUp(withRogue, "rogue"); // No skillChoice needed for a class already held.
    expect(second.skills).toEqual(first.skills); // Unchanged: the grant is one-time.
  });
});

describe("levelUp: combined multiclass spellcasting", () => {
  it("sums a full-caster level with a half-caster level (rounded down) into one shared slot table", () => {
    // Wizard 3 (full, contributes 3) + Paladin 2 (half, contributes 1) = combined caster level 4.
    const sheet = sheetWith("c-1", "u-1", {
      level: 4,
      classLevels: { wizard: 3, paladin: 1 },
      spellcasting: { ability: "int", spells: ["spell:fire-bolt"], slots: spellSlotsForLevel("full", 3) },
    } as never);
    const next = levelUp(sheet, "paladin"); // Paladin's 2nd level: half-caster contributes floor(2/2)=1.
    expect(next.spellcasting?.slots).toEqual(spellSlotsForLevel("full", 4));
    expect(next.spellcasting?.ability).toBe("int"); // The hero's primary (first) casting class.
  });

  it("keeps a solo Warlock on its own Pact Magic table, unaffected by the shared multiclass table", () => {
    const sheet = sheetWith("c-1", "u-1", {
      class: "warlock",
      classLevels: { warlock: 1 },
      spellcasting: { ability: "cha", spells: ["spell:eldritch-blast"], slots: spellSlotsForLevel("pact", 1) },
    } as never);
    const next = levelUp(sheet, "warlock");
    expect(next.spellcasting?.slots).toEqual(spellSlotsForLevel("pact", 2));
  });

  it("gives a Warlock level alongside another class no slots of its own (Pact Magic's separate pool is not modeled)", () => {
    const sheet = sheetWith("c-1", "u-1", {
      level: 3,
      classLevels: { fighter: 3 },
    });
    const next = levelUp(sheet, "warlock"); // Fighter 3 (none) + Warlock 1 (excluded alongside another class) = no caster.
    expect(next.spellcasting).toBeNull();
  });
});

describe("hitDicePool: one die per class level, largest first", () => {
  it("mixes a multiclass hero's die sizes in descending order", () => {
    const sheet = sheetWith("c-1", "u-1", { level: 8, classLevels: { fighter: 5, wizard: 3 }, hitDie: 10 } as never);
    expect(hitDicePool(sheet)).toEqual([10, 10, 10, 10, 10, 6, 6, 6]);
  });

  it("falls back to the single hitDie for a sheet from before multiclassing existed (no classLevels)", () => {
    const sheet = sheetWith("c-1", "u-1", { level: 3, classLevels: undefined, className: undefined } as never);
    expect(hitDicePool(sheet)).toEqual([10, 10, 10]);
  });
});

describe("chooseClassLevel command", () => {
  function campaignWithTorvin(): CampaignState {
    const base = newCampaign();
    const torvin = sheetWith("c-borin", "u-jamie", { level: 3, classLevels: { fighter: 3 } });
    return { ...base, characters: { ...base.characters, "c-borin": torvin } };
  }

  it("rejects a class the hero doesn't qualify for", () => {
    const state = campaignWithTorvin();
    expect(reject(state, jamie, { kind: "chooseClassLevel", characterId: "c-borin", buildClass: "wizard" })).toEqual({
      code: "multiclassRequirementNotMet",
    });
  });

  it("rejects an unknown class slug", () => {
    const state = campaignWithTorvin();
    expect(reject(state, jamie, { kind: "chooseClassLevel", characterId: "c-borin", buildClass: "necromancer" })).toEqual({
      code: "unknownClass",
    });
  });

  it("records a qualified class choice", () => {
    const state = campaignWithTorvin();
    const step = run(state, jamie, { kind: "chooseClassLevel", characterId: "c-borin", buildClass: "rogue", skillChoice: "stealth" });
    expect(step.state.characters["c-borin"]?.pendingClassLevel).toEqual({ buildClass: "rogue", skillChoice: "stealth" });
  });

  it("is cleared the moment the hero actually levels, once characterLeveledUp applies it (evolve.ts)", () => {
    const state = campaignWithTorvin();
    const declared = run(state, jamie, { kind: "chooseClassLevel", characterId: "c-borin", buildClass: "rogue", skillChoice: "stealth" });
    const sheet = declared.state.characters["c-borin"];
    if (sheet === undefined) throw new Error("unreachable");
    const next = levelUp(sheet, "rogue", "stealth");
    expect(next.classLevels).toEqual({ fighter: 3, rogue: 1 });
    expect(next.skills.stealth).toBe("proficient");

    const leveled = replay(declared.state, [
      {
        kind: "characterLeveledUp",
        characterId: "c-borin",
        level: next.level,
        maxHp: next.maxHp,
        abilityScores: next.abilityScores,
        spellcasting: next.spellcasting,
        features: next.features,
        classLevels: next.classLevels,
        skills: next.skills,
      },
    ]);
    expect(leveled.characters["c-borin"]?.pendingClassLevel).toBeUndefined();
    expect(leveled.characters["c-borin"]?.classLevels).toEqual({ fighter: 3, rogue: 1 });
  });
});
