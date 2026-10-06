import { describe, expect, it } from "vitest";

import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { raiseToLevel, xpThresholds } from "../../../src/domain/campaign/character/leveling.js";
import { levelingMode, startingLevelFor } from "../../../src/domain/campaign/rules/house-rules.js";
import { alex, jamie, mira, newCampaign, organizer, reject, ruleset, run } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

const milestone = ruleset({ [levelingMode.id]: "milestone" });

// The fixture heroes predate classes; a hero levels in the class it names.
function classed(): CampaignState {
  const base = newCampaign();
  return {
    ...base,
    characters: { ...base.characters, "c-mira": { ...(base.characters["c-mira"] as CharacterSheet), className: "rogue" }, "c-borin": { ...(base.characters["c-borin"] as CharacterSheet), className: "fighter" } },
  };
}

describe("the starting-level rule", () => {
  it("uses the adventure's level unless the table names one", () => {
    expect(startingLevelFor({}, undefined)).toBe(1);
    expect(startingLevelFor({}, 3)).toBe(3);
    expect(startingLevelFor({ "starting-level": "adventure" }, 4)).toBe(4);
    expect(startingLevelFor({ "starting-level": "level5" }, 2)).toBe(5);
    expect(startingLevelFor({ "starting-level": "level1" }, 4)).toBe(1);
  });
});

describe("raising a hero to a level", () => {
  it("levels a preset one level at a time and sets XP to the level's threshold", () => {
    const { ownerUserId: _owner, ...preset } = { ...mira, className: "rogue" };
    const raised = raiseToLevel(preset, 4);
    expect(raised.level).toBe(4);
    expect(raised.maxHp).toBeGreaterThan(preset.maxHp);
    expect(raised.xp).toBe(xpThresholds[3]);
    // Level 4 owes an Ability Score Improvement for the player to spend.
    expect(raised.pendingAsi).toBe(1);
  });

  it("leaves a hero already at the level alone", () => {
    expect(raiseToLevel(mira, 1)).toBe(mira);
  });
});

describe("the raiseLevel command", () => {
  it("raises every living hero, with an event per level and XP kept in step", () => {
    const step = run(classed(), organizer, { kind: "raiseLevel", level: 3 });
    const ups = step.events.filter((event) => event.kind === "characterLeveledUp");
    // Two heroes, two levels each.
    expect(ups).toHaveLength(4);
    for (const id of ["c-mira", "c-borin"]) {
      expect(step.state.characters[id]).toMatchObject({ level: 3, xp: xpThresholds[2] });
    }
  });

  it("leaves a hero who is already higher, and refuses when nobody would change", () => {
    const first = run(classed(), organizer, { kind: "raiseLevel", level: 3 });
    expect(reject(first.state, organizer, { kind: "raiseLevel", level: 3 })).toEqual({ code: "noLevelToRaise" });
    const second = run(first.state, organizer, { kind: "raiseLevel", level: 4 });
    expect(second.state.characters["c-mira"]?.level).toBe(4);
  });

  it("is the organizer's alone, in range, and not during a fight", () => {
    const state = classed();
    expect(reject(state, alex, { kind: "raiseLevel", level: 3 })).toEqual({ code: "notOrganizer" });
    expect(reject(state, organizer, { kind: "raiseLevel", level: 1 })).toEqual({ code: "invalidLevel" });
    expect(reject(state, organizer, { kind: "raiseLevel", level: 21 })).toEqual({ code: "invalidLevel" });
    const fight = new Fight(classed()).rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(reject(fight.state, organizer, { kind: "raiseLevel", level: 3 })).toEqual({ code: "inCombat" });
  });

  it("does not raise a hero who has fallen", () => {
    const base = classed();
    const fallen = { ...base, heroStatus: { ...base.heroStatus, "c-borin": { ...(base.heroStatus["c-borin"] ?? { hp: 0, resources: {} }), hp: 0, dead: true } } };
    const step = run(fallen as never, organizer, { kind: "raiseLevel", level: 2 });
    expect(step.state.characters["c-mira"]?.level).toBe(2);
    expect(step.state.characters["c-borin"]?.level).toBe(1);
  });
});

describe("leveling mode in a won fight", () => {
  const won = (rules: ReturnType<typeof ruleset>, spec = skirmish): Fight => {
    const fight = new Fight(classed(), rules).rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec });
    fight.rolls([15], [6]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-b" });
    fight.rolls([15], [8]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-b", weapon: "item:longsword" });
    return fight;
  };

  it("gives XP at an experience table", () => {
    const fight = won(ruleset());
    expect(fight.events).toContainEqual(expect.objectContaining({ kind: "experienceAwarded" }));
  });

  it("gives no XP at a milestone table", () => {
    const fight = won(milestone);
    expect(fight.events).toContainEqual({ kind: "encounterEnded", outcome: "victory" });
    expect(fight.events.some((event) => event.kind === "experienceAwarded")).toBe(false);
    expect(fight.state.characters["c-mira"]?.level).toBe(1);
  });

  it("levels the party when the fight is an authored milestone", () => {
    const fight = won(milestone, { ...skirmish, milestoneLevel: 2 });
    expect(fight.state.characters["c-mira"]).toMatchObject({ level: 2, xp: xpThresholds[1] });
    expect(fight.state.characters["c-borin"]?.level).toBe(2);
  });

  it("ignores an authored milestone where XP levels the party", () => {
    const fight = won(ruleset(), { ...skirmish, milestoneLevel: 5 });
    expect(fight.state.characters["c-mira"]?.level).toBe(1);
  });
});
