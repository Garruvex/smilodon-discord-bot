import { describe, expect, it } from "vitest";

import { alex, jamie, newCampaign, organizer, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// A side taken by surprise cannot act or react until its first turn has passed.

describe("surprise", () => {
  it("costs the surprised foes their first turn, however high they rolled", () => {
    const fight = new Fight(newCampaign()).rolls([1, 1, 1, 20, 20]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, id: "enc-ambush", surprised: "foes" } });
    expect(fight.combatant("goblin-a").effects.some((effect) => effect.conditions.includes("condition:surprised"))).toBe(true);
    // The goblins topped the order but did nothing: the fight waits for a hero.
    expect(fight.events.some((event) => event.kind === "resolutionDeclared")).toBe(false);
    const players = { "c-mira": alex, "c-borin": jamie, "c-elspeth": sam } as const;
    for (let turns = 0; turns < 3; turns += 1) {
      const encounter = fight.encounter;
      const id = encounter?.order[encounter.turnIndex] as keyof typeof players;
      fight.run(players[id], { kind: "endTurn", combatantId: id });
    }
    // Round two: the surprise has lapsed and the goblins act.
    expect(fight.combatant("goblin-a").effects.some((effect) => effect.conditions.includes("condition:surprised"))).toBe(false);
    expect(fight.events.some((event) => event.kind === "resolutionDeclared" && event.resolution.actorId.startsWith("goblin"))).toBe(true);
  });

  it("leaves everyone alone when nobody is surprised", () => {
    const fight = new Fight(newCampaign()).rolls([1, 1, 1, 20, 20]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, id: "enc-open" } });
    expect(fight.events.some((event) => event.kind === "resolutionDeclared")).toBe(true);
  });
});
