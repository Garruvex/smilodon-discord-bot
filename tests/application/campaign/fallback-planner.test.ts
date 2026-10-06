import { describe, expect, it } from "vitest";

import { fallbackPlan } from "../../../src/application/campaign/dm/fallback-planner.js";
import type { PlannerRequest } from "../../../src/application/campaign/ports/dm-ports.js";

const request = (actions: readonly string[], interactions: readonly { id: string; label: string; sceneId?: string }[]): PlannerRequest => ({
  context: {} as PlannerRequest["context"],
  roundNumber: 3,
  actions: actions.map((text, index) => ({ characterId: `c-${index}`, heroName: `Hero ${index}`, text })),
  vocabulary: { abilities: [], skills: [], dcTiers: [], rollModeReasons: [] },
  story: {
    sceneId: "scene:a", sceneIds: ["scene:a"], encounters: [], clocks: [], clues: [],
    interactions: interactions.map((interaction) => ({ id: interaction.id, sceneId: interaction.sceneId ?? "scene:a", label: interaction.label })),
  },
  previousProblems: [],
});

describe("planning without the model", () => {
  it("takes an unmatched action at face value with no story effect", () => {
    const plan = fallbackPlan(request(["I admire the view"], [{ id: "interaction:search", label: "Search the old chest" }]));
    expect(plan.effects).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ characterId: "c-0", resolution: { kind: "automatic" } });
    expect(plan.actions[0]).not.toHaveProperty("interactionId");
  });

  it("plans an action that clearly matches an authored interaction as an attempt at it", () => {
    const plan = fallbackPlan(request(["I want to search the old chest carefully"], [{ id: "interaction:search", label: "Search the old chest" }, { id: "interaction:talk", label: "Talk to the guard" }]));
    expect(plan.actions[0]).toMatchObject({ interactionId: "interaction:search" });
  });

  it("never plans an action the player refused as an attempt at it", () => {
    const labels = [{ id: "interaction:attack", label: "Attack the guard" }];
    expect(fallbackPlan(request(["I do not attack the guard"], labels)).actions[0]).not.toHaveProperty("interactionId");
    expect(fallbackPlan(request(["我不要攻擊守衛"], [{ id: "interaction:attack", label: "攻擊守衛" }])).actions[0]).not.toHaveProperty("interactionId");
    expect(fallbackPlan(request(["I attack the guard"], labels)).actions[0]).toMatchObject({ interactionId: "interaction:attack" });
  });

  it("matches Chinese labels, ignoring the skill in brackets", () => {
    const plan = fallbackPlan(request(["我想觀察班特，看他有沒有隱瞞什麼"], [{ id: "interaction:sense", label: "觀察班特，看他有沒有隱瞞什麼（洞悉）" }, { id: "interaction:coax", label: "說服班特說出守夜時真正發生了什麼（魅力）" }]));
    expect(plan.actions[0]).toMatchObject({ interactionId: "interaction:sense" });
  });

  it("does not guess between two interactions that fit equally well, nor use one from another scene", () => {
    const labels = [{ id: "interaction:a", label: "Open the north door" }, { id: "interaction:b", label: "Open the south door" }];
    expect(fallbackPlan(request(["open the door"], labels)).actions[0]).not.toHaveProperty("interactionId");
    expect(fallbackPlan(request(["search the old chest"], [{ id: "interaction:far", label: "Search the old chest", sceneId: "scene:elsewhere" }])).actions[0]).not.toHaveProperty("interactionId");
  });

  it("gives one interaction to one hero only", () => {
    const plan = fallbackPlan(request(["search the old chest", "search the old chest too"], [{ id: "interaction:search", label: "Search the old chest" }]));
    expect(plan.actions.filter((action) => "interactionId" in action)).toHaveLength(1);
  });
});
