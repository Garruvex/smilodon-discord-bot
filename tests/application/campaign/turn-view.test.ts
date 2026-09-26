import { describe, expect, it } from "vitest";

import { buildTurnView } from "../../../src/application/campaign/views/turn-view.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { alex, newCampaign, organizer, ruleset } from "../../domain/campaign/campaign-fixtures.js";
import { Fight, skirmish } from "../../domain/campaign/combat-fixtures.js";

const bible = loadStarterAdventure().en.bible;
const rules = ruleset();

const viewOf = (state: CampaignState, hero: string): ReturnType<typeof buildTurnView> =>
  buildTurnView(state, rules.content, rules.houseRules, { state, bible, glossary: enSrd51Glossary }, hero);

// Mira (20) goes first, then Borin (15); two goblins wait in the courtyard, 20 ft away.
const start = (): Fight => new Fight().rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });

describe("a hero's turn view", () => {
  it("is only there for the hero whose turn it is", () => {
    const fight = start();
    expect(viewOf(fight.state, "c-mira")).not.toBeNull();
    expect(viewOf(fight.state, "c-borin")).toBeNull();
    expect(viewOf(newCampaign(), "c-mira")).toBeNull();
  });

  it("offers only what is legal: no attack out of reach, but moving and dodging", () => {
    const view = viewOf(start().state, "c-mira");
    expect(view?.zone).toBe("Gate");
    expect(view?.attacks.filter((attack) => !attack.ranged)).toEqual([]);
    expect(view?.moves).toEqual([{ zoneId: "courtyard", zone: "Courtyard", feet: 20 }]);
    expect(view?.engage).toEqual([]);
    expect(view?.canDodge).toBe(true);
    expect(view?.canWithdraw).toBe(false);
    expect(view?.budget).toMatchObject({ action: true, bonusAction: true, reaction: true });
  });

  it("lists the foes to close in on, then to hit, with letters and health bands", () => {
    const fight = start().run(alex, { kind: "combatMove", combatantId: "c-mira", zoneId: "courtyard" });
    const near = viewOf(fight.state, "c-mira");
    expect(near?.engage.map((target) => target.name)).toEqual(["Goblin A", "Goblin B"]);
    expect(near?.engage[0]).toMatchObject({ band: "unhurt", side: "foes", zone: "Courtyard" });

    const engaged = fight.run(alex, { kind: "combatEngage", combatantId: "c-mira", targetId: "goblin-a" });
    const view = viewOf(engaged.state, "c-mira");
    const melee = view?.attacks.find((attack) => !attack.ranged);
    expect(melee?.targets.map((target) => target.id)).toEqual(["goblin-a"]);
    expect(view?.engagedWith).toEqual(["Goblin A"]);
    expect(view?.canWithdraw).toBe(false);
  });

  it("drops actions the turn can no longer pay for, and marks a resolving attack busy", () => {
    const fight = start().run(alex, { kind: "combatDodge", combatantId: "c-mira" });
    const view = viewOf(fight.state, "c-mira");
    expect(view?.budget.action).toBe(false);
    expect(view?.attacks).toEqual([]);
    expect(view?.canDodge).toBe(false);
    expect(view?.busy).toBe(false);
    expect(view?.hasUnspent).toBe(false);
  });

  it("moves to the next hero when a turn ends", () => {
    const fight = start().run(alex, { kind: "endTurn", combatantId: "c-mira" }).rolls([2, 2]);
    expect(viewOf(fight.state, "c-mira")).toBeNull();
    expect(viewOf(fight.state, "c-borin")).not.toBeNull();
  });
});
