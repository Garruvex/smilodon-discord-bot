import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import { applyProgression, levelUp, progressionOf, progressionProblems, xpThresholds } from "../../../src/domain/campaign/character/leveling.js";
import { savingThrowModifier, type CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { conditionLookup } from "../../../src/domain/campaign/effects/effect-queries.js";
import { attackMode } from "../../../src/domain/campaign/engine/combat/attack-rules.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, d20Roll, jamie, newCampaign, organizer, partyOfThree, run, ruleset, sam, system } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Class features from level 6 up that the engine reads.

function withFeatures(state: CampaignState, heroId: string, features: readonly string[]): CampaignState {
  const sheet = state.characters[heroId];
  if (sheet === undefined) throw new Error(heroId);
  return { ...state, characters: { ...state.characters, [heroId]: { ...sheet, features: [...sheet.features, ...features] as typeof sheet.features } } };
}

describe("saving throw proficiencies", () => {
  it("Slippery Mind adds Wisdom saves and Diamond Soul adds them all", () => {
    const mira = withFeatures(newCampaign(), "c-mira", []).characters["c-mira"];
    if (mira === undefined) throw new Error("mira");
    const plain = savingThrowModifier(mira, "wis");
    const slippery = { ...mira, features: [...mira.features, "feature:slippery-mind"] as typeof mira.features };
    expect(mira.savingThrows.includes("wis")).toBe(false);
    expect(savingThrowModifier(slippery, "wis")).toBe(plain + mira.proficiencyBonus);
    expect(savingThrowModifier(slippery, "cha")).toBe(savingThrowModifier(mira, "cha"));
    const diamond = { ...mira, features: [...mira.features, "feature:diamond-soul"] as typeof mira.features };
    expect(savingThrowModifier(diamond, "cha")).toBe(savingThrowModifier(mira, "cha") + (mira.savingThrows.includes("cha") ? 0 : mira.proficiencyBonus));
  });
});

describe("Indomitable Might", () => {
  it("lifts a Strength check total to the Strength score", () => {
    const base = withFeatures(newCampaign(), "c-mira", ["feature:indomitable-might"]);
    const opened = run(base, system, { kind: "openRound" }).state;
    const acted = run(run(opened, alex, { kind: "submitAction", characterId: "c-mira", text: "I heave the gate." }).state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    const planned = run(acted, system, {
      kind: "applyRoundPlan",
      proposal: { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "ability", ability: "str" }, dcTier: "hard", rollModeReasons: [] } }] },
    }).state;
    const clicked = run(planned, alex, { kind: "requestRoll", checkId: "r1:c-mira" });
    const spec = clicked.state.checks["r1:c-mira"]?.spec;
    if (spec === undefined) throw new Error("check");
    const strength = base.characters["c-mira"]?.abilityScores.str ?? 0;
    const resolved = run(clicked.state, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll(spec.mode, [2], spec.modifier) } });
    expect(resolved.events.find((event) => event.kind === "checkResolved")).toMatchObject({ result: { roll: { total: strength } } });
  });
});

describe("Survivor", () => {
  it("heals a bloodied fighter as their turn begins", () => {
    const base = withFeatures(newCampaign(), "c-borin", ["feature:survivor"]);
    const state: CampaignState = { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp: 5, resources: { spellSlots: {}, featureUses: {} } } } };
    const fight = new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    // 5 + Constitution modifier (+2), on 5 of 12.
    expect(fight.combatant("c-borin").hp).toBe(12);
  });
});

describe("Elusive", () => {
  function modeAgainst(features: readonly string[]): string {
    const base = withFeatures(newCampaign(), "c-borin", ["feature:reckless-attack", ...features]);
    const fight = new Fight(base).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:reckless-attack" });
    const lookup = conditionLookup(ruleset().content);
    return attackMode(fight.encounter, fight.combatant("goblin-a"), fight.combatant("c-borin"), false, false, lookup).mode;
  }

  it("takes advantage away from attacks against the holder", () => {
    expect(modeAgainst([])).toBe("advantage");
    expect(modeAgainst(["feature:elusive"])).toBe("normal");
  });
});

describe("Primal Champion", () => {
  it("raises Strength and Constitution by 4 at barbarian level 20, and survives a saved progression", () => {
    const build: BuildChoices = { class: "barbarian", kit: "berserker", abilities: { str: 15, dex: 12, con: 14, int: 8, wis: 10, cha: 8 }, skills: ["athletics", "perception"], expertise: [], name: "Grok", appearance: "", backstory: "" };
    let sheet = deriveSheet(build);
    for (let level = 2; level <= 20; level += 1) sheet = { ...sheet, ...levelUp(sheet as unknown as CharacterSheet, "barbarian") };
    expect(sheet.abilityScores).toMatchObject({ str: 19, con: 18, dex: 12 });
    expect(sheet.features).toContain("feature:primal-champion");
    const progression = progressionOf({ ...sheet, xp: xpThresholds[19] } as unknown as CharacterSheet);
    expect(progressionProblems(deriveSheet(build), progression)).toEqual([]);
    expect(applyProgression(deriveSheet(build), progression).abilityScores).toMatchObject({ str: 19, con: 18 });
  });
});

describe("Divine Strike, Dark One's Blessing and Potent Cantrip", () => {
  function skirmishWith(heroId: string, features: readonly string[]): Fight {
    return new Fight(withFeatures(partyOfThree(), heroId, features)).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
  }

  it("Divine Strike adds a radiant die to a weapon hit", () => {
    const shoot = (features: readonly string[], dice: readonly number[]): number => {
      const fight = skirmishWith("c-mira", features);
      fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
      fight.rolls([15], dice).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
      return 7 - fight.combatant("goblin-a").hp;
    };
    const plain = shoot([], [1]);
    expect(shoot(["feature:divine-strike"], [1, 3])).toBe(plain + 3);
  });

  it("Dark One's Blessing gives temporary hit points for a kill", () => {
    const fight = skirmishWith("c-elspeth", ["feature:dark-ones-blessing"]);
    fight.rolls([5], [8]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    // Wisdom modifier 3 plus level 1.
    expect(fight.combatant("c-elspeth").tempHp).toBe(4);
  });

  it("Potent Cantrip halves a damaging cantrip that was saved against", () => {
    const flame = (features: readonly string[], dice: readonly number[]): number => {
      const fight = skirmishWith("c-elspeth", features);
      fight.rolls([15], dice).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
      return fight.combatant("goblin-a").hp;
    };
    expect(flame([], [])).toBe(7);
    expect(flame(["feature:potent-cantrip"], [6])).toBe(4);
  });
});

describe("Deflect Missiles", () => {
  it("uses the reaction to turn a ranged hit down", () => {
    const struck = (features: readonly string[]): { readonly lost: number; readonly reaction: boolean } => {
      const state = withFeatures(partyOfThree(), "c-elspeth", features);
      const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
      fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
      const before = fight.combatant("c-elspeth").hp;
      fight.rolls(Array.from({ length: 6 }, () => 19), Array.from({ length: 6 }, () => 6)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
      return { lost: before - fight.combatant("c-elspeth").hp, reaction: fight.combatant("c-elspeth").budget.reaction };
    };
    const plain = struck([]);
    const deflected = struck(["feature:deflect-missiles"]);
    expect(plain).toMatchObject({ reaction: true });
    expect(plain.lost).toBeGreaterThan(0);
    expect(deflected.reaction).toBe(false);
    expect(deflected.lost).toBeLessThan(plain.lost);
  });
});

describe("Fighting Style: Protection", () => {
  it("spends a neighbor's reaction to give an attack on an ally disadvantage", () => {
    const state = withFeatures(partyOfThree(), "c-borin", ["feature:fighting-style-protection"]);
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 6 }, () => 10), Array.from({ length: 6 }, () => 3)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    const shot = fight.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
    expect(shot?.resolution.targetIds).toEqual(["c-elspeth"]);
    expect(Object.values(shot?.resolution.checks ?? {})[0]?.spec.mode).toBe("disadvantage");
    expect(fight.events).toContainEqual({ kind: "uncannyDodgeUsed", combatantId: "c-borin" });
  });
});
