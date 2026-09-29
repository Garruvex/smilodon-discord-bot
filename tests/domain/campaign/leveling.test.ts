import { describe, expect, it } from "vitest";

import {
  asiLevels,
  casterTypeOf,
  defaultAsiAllocation,
  hpGainForLevel,
  levelForXp,
  applyProgression,
  levelUp,
  progressionOf,
  progressionProblems,
  proficiencyBonusForLevel,
  spellSlotsForLevel,
  xpForNextLevel,
  xpThresholds,
} from "../../../src/domain/campaign/character/leveling.js";
import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";

const wizardBuild: BuildChoices = {
  class: "wizard",
  kit: "scholar",
  abilities: { str: 8, dex: 12, con: 14, int: 15, wis: 13, cha: 10 },
  skills: ["arcana", "history"],
  expertise: [],
  name: "Elowen",
  appearance: "",
  backstory: "",
};

describe("XP and levels", () => {
  it("reads a level from total XP by the SRD thresholds", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(299)).toBe(1);
    expect(levelForXp(300)).toBe(2);
    expect(levelForXp(2700)).toBe(4);
    expect(levelForXp(355000)).toBe(20);
    expect(levelForXp(999999)).toBe(20);
  });

  it("gives the XP needed for the next level, and null past 20", () => {
    expect(xpForNextLevel(1)).toBe(xpThresholds[1]);
    expect(xpForNextLevel(19)).toBe(xpThresholds[19]);
    expect(xpForNextLevel(20)).toBeNull();
  });

  it("raises the proficiency bonus every four levels", () => {
    expect(proficiencyBonusForLevel(1)).toBe(2);
    expect(proficiencyBonusForLevel(4)).toBe(2);
    expect(proficiencyBonusForLevel(5)).toBe(3);
    expect(proficiencyBonusForLevel(17)).toBe(6);
    expect(proficiencyBonusForLevel(20)).toBe(6);
  });

  it("takes the average of the Hit Die plus the Constitution modifier", () => {
    expect(hpGainForLevel(6, 14)).toBe(4 + 2); // 1d6 average 4, +2 Con
    expect(hpGainForLevel(12, 8)).toBe(7 - 1); // 1d12 average 7, -1 Con
  });

  it("knows each class's caster type", () => {
    expect(casterTypeOf("wizard")).toBe("full");
    expect(casterTypeOf("paladin")).toBe("half");
    expect(casterTypeOf("warlock")).toBe("pact");
    expect(casterTypeOf("fighter")).toBe("none");
  });

  it("has no spell slots for a half-caster at level 1, then grows them", () => {
    expect(spellSlotsForLevel("half", 1)).toEqual({});
    expect(spellSlotsForLevel("half", 2)).toEqual({ 1: 2 });
    expect(spellSlotsForLevel("full", 5)).toEqual({ 1: 4, 2: 3, 3: 2 });
  });

  it("keeps a pact caster to one slot level at a time, growing its count", () => {
    expect(spellSlotsForLevel("pact", 1)).toEqual({ 1: 1 });
    expect(spellSlotsForLevel("pact", 3)).toEqual({ 2: 2 });
    expect(spellSlotsForLevel("pact", 11)).toEqual({ 5: 3 });
  });

  it("puts an ASI on the class's leading ability, capped at 20", () => {
    const scores = defaultAsiAllocation("wizard", { str: 8, dex: 12, con: 14, int: 19, wis: 13, cha: 10 });
    // Int is capped by the remaining point (19 -> 20); the rest goes to Con, next in "suggested".
    expect(scores.int).toBe(20);
    expect(scores.con).toBe(15);
  });

  it("levels a hero up: HP, and spell slots once a caster reaches them", () => {
    const sheet = { ...deriveSheet(wizardBuild), id: "c-1" as never, ownerUserId: "u-1" as never };
    const next = levelUp(sheet, "wizard");
    expect(next.level).toBe(2);
    expect(next.maxHp).toBeGreaterThan(sheet.maxHp);
    expect(next.spellcasting?.slots).toEqual({ 1: 3 });
  });

  it("gives a paladin real known spells the moment it first gains slots, not an empty list", () => {
    const paladinBuild: BuildChoices = {
      class: "paladin",
      kit: "oath",
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      skills: ["athletics", "religion"],
      expertise: [],
      name: "Sera",
      appearance: "",
      backstory: "",
    };
    const sheet = { ...deriveSheet(paladinBuild), id: "c-2" as never, ownerUserId: "u-2" as never };
    expect(sheet.spellcasting).toBeNull();
    const next = levelUp(sheet, "paladin");
    expect(next.spellcasting?.ability).toBe("cha");
    expect(next.spellcasting?.spells.length).toBeGreaterThan(0);
    expect(next.spellcasting?.slots).toEqual({ 1: 2 });
  });

  it("grants narrative class features on the levels that give them", () => {
    const sheet = { ...deriveSheet(wizardBuild), id: "c-3" as never, ownerUserId: "u-3" as never };
    const toLevel2 = levelUp(sheet, "wizard");
    expect(toLevel2.features).toContain("feature:school-of-evocation");
    expect(toLevel2.features).toEqual(expect.arrayContaining([...sheet.features]));
  });

  it("grants no new features on a level with none listed", () => {
    const sheet = { ...deriveSheet(wizardBuild), id: "c-4" as never, ownerUserId: "u-4" as never, level: 2, classLevels: { wizard: 2 } };
    const toLevel3 = levelUp(sheet, "wizard");
    expect(toLevel3.features).toEqual(sheet.features);
  });

  it("owes an Ability Score Improvement on its levels, for the player to allocate, rather than picking for them", () => {
    expect(asiLevels).toContain(4);
    const abilityScores = { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 };
    const base = { hitDie: 10, abilityScores, features: [], skills: {} };
    const sheet = { ...base, level: 3, classLevels: { fighter: 3 } } as never;
    const toLevel4 = levelUp(sheet, "fighter");
    // Nothing is allocated yet: the scores are untouched, and one is owed.
    expect(toLevel4.abilityScores).toEqual(abilityScores);
    expect(toLevel4.pendingAsi).toBe(1);
    // A non-ASI level owes nothing more, and a second ASI level stacks.
    const level5 = { ...base, level: 4, classLevels: toLevel4.classLevels, pendingAsi: toLevel4.pendingAsi } as never;
    expect(levelUp(level5, "fighter").pendingAsi).toBe(1);
    const level7 = { ...base, level: 7, classLevels: toLevel4.classLevels, pendingAsi: toLevel4.pendingAsi } as never;
    expect(levelUp(level7, "fighter").pendingAsi).toBe(2);
  });
});

describe("saved progress", () => {
  const base = { ...deriveSheet(wizardBuild), id: "c-p" as never, ownerUserId: "u-p" as never };

  // Levels a hero live the way a campaign does: level after level, spending
  // each Improvement as it comes.
  function liveHero(levels: number): typeof base {
    let sheet = base as never as Parameters<typeof levelUp>[0];
    for (let level = 2; level <= levels; level += 1) {
      const next = levelUp(sheet, "wizard");
      sheet = { ...sheet, ...next, xp: xpThresholds[level - 1] ?? 0 };
      if (asiLevels.includes(level)) sheet = { ...sheet, abilityScores: { ...sheet.abilityScores, int: sheet.abilityScores.int + 2 }, pendingAsi: (sheet.pendingAsi ?? 1) - 1 };
    }
    return sheet as never;
  }

  it("replays to the same hero a live level-up made, without storing a derived number", () => {
    const live = liveHero(5);
    const progress = progressionOf(live);
    expect(progress).not.toHaveProperty("maxHp");
    expect(progressionProblems(deriveSheet(wizardBuild), progress)).toEqual([]);
    const replayed = applyProgression(deriveSheet(wizardBuild), progress);
    expect(replayed).toMatchObject({ level: 5, maxHp: live.maxHp, abilityScores: live.abilityScores, features: live.features, classLevels: live.classLevels, pendingAsi: 0 });
    expect(replayed.spellcasting).toEqual(live.spellcasting);
  });

  it("refuses progress that does not add up", () => {
    const build = deriveSheet(wizardBuild);
    const progress = progressionOf(liveHero(5));
    expect(progressionProblems(build, { ...progress, xp: 0 })).toContainEqual({ code: "xpLevelMismatch" });
    expect(progressionProblems(build, { ...progress, abilityScores: { ...progress.abilityScores, str: 20, dex: 20 } })).toContainEqual({ code: "asiPointsExceeded" });
    expect(progressionProblems(build, { ...progress, pendingAsi: 3 })).toContainEqual({ code: "pendingAsiExceeded" });
    expect(progressionProblems(build, { ...progress, classLevels: { rogue: 5 } })).toContainEqual({ code: "missingStartingClassLevel" });
    expect(progressionProblems(build, { ...progress, classLevels: { wizard: 25 } })).toContainEqual({ code: "invalidLevel" });
  });
});
