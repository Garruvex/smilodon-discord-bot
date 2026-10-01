import { describe, expect, it } from "vitest";

import type { PanelMode } from "../../../src/application/campaign/views/campaign-views.js";
import { panelActionKind, panelActions, } from "../../../src/application/campaign/views/panel-actions.js";

type Input = Parameters<typeof panelActions>[0];
const fight = (playersControl: boolean): Input => ({ mode: "combat", combat: { playersControl } as never });
const outside = (mode: PanelMode): Input => ({ mode, combat: null });

describe("panelActions", () => {
  it("offers act, speak and pass while the round is collecting", () => {
    expect(panelActions(outside("collecting")).primary).toEqual(["act", "speak", "pass", "myHero", "away"]);
  });

  it("offers Explore and the safety controls between fights, with no second away button", () => {
    expect(panelActions(outside("collecting")).secondary).toEqual(["explore", "safety", "more"]);
  });

  it("adds the away toggle to the second row when the first does not hold it", () => {
    expect(panelActions(outside("paused"))).toEqual({ primary: ["myHero"], secondary: ["explore", "safety", "more", "away"] });
  });

  it("drops Explore during a fight", () => {
    expect(panelActions(fight(false))).toEqual({ primary: ["myHero"], secondary: ["safety", "more", "away"] });
  });

  it("opens the turn controls when the players run the fight", () => {
    expect(panelActions(fight(true)).primary).toEqual(["turn", "endTurn", "speak", "myHero", "away"]);
  });

  it("offers nothing once the game is archived", () => {
    expect(panelActions(outside("archived"))).toEqual({ primary: [], secondary: [] });
  });

  it("keeps each row within Discord's five buttons, leaving room for the Party link", () => {
    const modes: readonly PanelMode[] = ["opening", "readyCheck", "collecting", "planning", "awaitingRolls", "waiting", "paused", "safety", "recovery", "archived"];
    for (const mode of modes) {
      const { primary, secondary } = panelActions(outside(mode));
      expect(primary.length).toBeLessThanOrEqual(5);
      expect(secondary.length).toBeLessThanOrEqual(4);
    }
    for (const control of [true, false]) {
      const { primary, secondary } = panelActions(fight(control));
      expect(primary.length).toBeLessThanOrEqual(5);
      expect(secondary.length).toBeLessThanOrEqual(4);
    }
  });

  it("offers Stay here first on the second row while a move waits and the round is collecting", () => {
    const pendingMove = { sceneTitle: "Chapel", staying: [], stayingUserIds: [] };
    expect(panelActions({ ...outside("collecting"), pendingMove }).secondary).toEqual(["stay", "explore", "safety", "more"]);
    expect(panelActions({ ...outside("planning"), pendingMove }).secondary).not.toContain("stay");
    expect(panelActions({ ...fight(true), pendingMove }).secondary).not.toContain("stay");
    expect(panelActions({ ...outside("collecting"), pendingMove }).secondary.length).toBeLessThanOrEqual(4);
  });

  it("classifies actions by what they do", () => {
    expect(panelActionKind("act")).toBe("game");
    expect(panelActionKind("myHero")).toBe("navigation");
    expect(panelActionKind("safety")).toBe("table");
  });
});
