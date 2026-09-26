import { describe, expect, it } from "vitest";

import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, borin, jamie, kinds, mira, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Ends the fight with Borin dead and Mira standing, the way a third failed
// death save would leave it.
function borinFell(state: CampaignState = newCampaign()): CampaignState {
  const fight = new Fight(state).rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
  const encounter = {
    ...fight.encounter,
    combatants: Object.fromEntries(
      Object.entries(fight.encounter.combatants).map(([id, combatant]) => [id, id === "c-borin" ? { ...combatant, hp: 0, condition: "dead" as const } : combatant]),
    ),
  };
  return replay({ ...fight.state, encounter }, [{ kind: "encounterEnded", outcome: "victory" }]);
}

const newHero = (id: string, owner: string, level = 1): CharacterSheet => ({ ...borin, id, ownerUserId: owner, name: "Borin II", level });

describe("a hero who dies", () => {
  it("stays dead, and their gear joins the party stash", () => {
    const state = borinFell();
    expect(state.heroStatus["c-borin"]).toMatchObject({ hp: 0, dead: true });
    expect(state.characters["c-borin"]?.equipment).toEqual([]);
    expect(state.stash).toEqual(borin.equipment);
    expect(state.heroStatus["c-mira"]?.hp).toBeGreaterThan(0);
  });

  it("no longer takes part in rounds, fights, or rests", () => {
    const state = borinFell();
    const round = run(state, system, { kind: "openRound" });
    expect(round.state.round?.participants).toEqual(["c-mira"]);
    const fight = new Fight(state).rolls([20, 5, 4]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, id: "enc-2" } });
    expect(Object.keys(fight.encounter.combatants).filter((id) => id.startsWith("c-"))).toEqual(["c-mira"]);
    const rested = run(state, organizer, { kind: "takeRest", rest: "long" }).state;
    expect(rested.heroStatus["c-borin"]).toMatchObject({ hp: 0, dead: true });
  });

  it("drops trade offers that involved them", () => {
    const offer = run(newCampaign(), alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null }).state;
    expect(borinFell(offer).offers).toEqual({});
  });
});

describe("a lost fight", () => {
  it("wakes the beaten heroes with 1 HP and keeps them alive", () => {
    const fight = new Fight().rolls([5, 4, 20, 19, 20, 20], [6, 6, 6, 6]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(fight.events.at(-1)).toEqual({ kind: "encounterEnded", outcome: "defeat" });
    expect(fight.state.heroStatus["c-mira"]).toMatchObject({ hp: 1 });
    expect(fight.state.heroStatus["c-mira"]?.dead).toBeUndefined();
    expect(run(fight.state, system, { kind: "openRound" }).state.round?.participants).toEqual(["c-mira", "c-borin"]);
  });
});

describe("joining as a new hero", () => {
  it("lets a player whose hero fell take a new one at the party's level, with no loot", () => {
    const state = borinFell();
    const joined = run(state, jamie, { kind: "joinHero", sheet: newHero("c-borin-2", "u-jamie") }).state;
    expect(joined.members["u-jamie"]?.characterId).toBe("c-borin-2");
    expect(joined.characters["c-borin-2"]?.equipment).toEqual(borin.equipment);
    // The fallen hero's gear stays in the stash for the party.
    expect(joined.stash).toEqual(borin.equipment);
    expect(run(joined, system, { kind: "openRound" }).state.round?.participants).toEqual(["c-mira", "c-borin-2"]);
  });

  it("lets a new player join the party", () => {
    const sheet: CharacterSheet = { ...mira, id: "c-pip", ownerUserId: "u-sam", name: "Pip" };
    const joined = run(newCampaign(), organizer, { kind: "joinHero", sheet }).state;
    expect(joined.members["u-sam"]).toMatchObject({ characterId: "c-pip", availability: "present" });
  });

  it("refuses a hero for a player who still has a living one", () => {
    expect(reject(newCampaign(), jamie, { kind: "joinHero", sheet: newHero("c-borin-2", "u-jamie") })).toEqual({ code: "heroNotReplaceable" });
  });

  it("refuses someone else's hero, the wrong level, an unknown item, and a repeated ID", () => {
    const state = borinFell();
    expect(reject(state, alex, { kind: "joinHero", sheet: newHero("c-borin-2", "u-jamie") })).toEqual({ code: "notOrganizer" });
    expect(reject(state, jamie, { kind: "joinHero", sheet: newHero("c-borin-2", "u-jamie", 5) })).toMatchObject({ code: "invalidHero" });
    expect(reject(state, jamie, { kind: "joinHero", sheet: { ...newHero("c-borin-2", "u-jamie"), equipment: ["item:vorpal-sword"] } })).toMatchObject({ code: "invalidHero" });
    expect(reject(state, jamie, { kind: "joinHero", sheet: newHero("c-borin", "u-jamie") })).toMatchObject({ code: "invalidHero" });
  });
});

describe("loot", () => {
  it("goes to the stash when the party wins", () => {
    const loot = ["item:scimitar", "item:javelin"] as const;
    const fight = new Fight().rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, loot, gold: 15 } });
    fight.rolls([15], [6]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-b" });
    fight.rolls([15], [8]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-b", weapon: "item:longsword" });
    expect(kinds(fight.events)).toContain("lootFound");
    expect(fight.state.stash).toEqual(loot);
    expect(fight.state.gold).toBe(15);
  });

  it("is not found when the party loses, and unknown loot is refused", () => {
    const lost = new Fight().rolls([5, 4, 20, 19, 20, 20], [6, 6, 6, 6]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, loot: ["item:scimitar"] } });
    expect(lost.state.stash).toEqual([]);
    expect(reject(newCampaign(), organizer, { kind: "startEncounter", spec: { ...skirmish, loot: ["item:vorpal-sword"] } })).toMatchObject({ code: "invalidEncounter" });
  });
});
