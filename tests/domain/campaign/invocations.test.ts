import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Warlock invocations: Agonizing Blast adds the spellcasting modifier to Eldritch Blast.

function withBlast(features: readonly string[]): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  const casting = elspeth?.spellcasting;
  if (elspeth === undefined || casting === undefined || casting === null) throw new Error("elspeth");
  return {
    ...base,
    characters: {
      ...base.characters,
      "c-elspeth": { ...elspeth, features: [...elspeth.features, ...features] as typeof elspeth.features, spellcasting: { ...casting, spells: [...casting.spells, "spell:eldritch-blast"] as typeof casting.spells } },
    },
  };
}

const blast = (state: CampaignState): number => {
  const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
  fight.rolls([15], [5]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:eldritch-blast", slotLevel: 0, targetIds: ["goblin-a"] });
  return 7 - fight.combatant("goblin-a").hp;
};

describe("Agonizing Blast", () => {
  it("adds the spellcasting modifier to the blast's damage", () => {
    const plain = blast(withBlast([]));
    const agonizing = blast(withBlast(["feature:agonizing-blast"]));
    expect(plain).toBe(5);
    expect(agonizing).toBeGreaterThan(plain);
  });
});
