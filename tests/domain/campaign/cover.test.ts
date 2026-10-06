import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, organizer, partyOfThree, partyWithSpells, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Cover: creatures in a zone with cover are harder to hit, or to catch in a Dexterity effect, from another zone.

const withCover = (cover?: "half" | "three-quarters"): EncounterSpec => ({ ...skirmish, zones: skirmish.zones.map((zone) => (zone.id === "courtyard" && cover !== undefined ? { ...zone, cover } : zone)) });

function armorClassSeen(cover?: "half" | "three-quarters"): number {
  const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: withCover(cover) });
  fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
  fight.rolls([15], [1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
  const shot = fight.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
  return Object.values(shot?.resolution.checks ?? {})[0]?.against ?? 0;
}

describe("cover", () => {
  it("adds 2 or 5 to the armor class of a creature in a zone with cover, against attacks from another zone", () => {
    const open = armorClassSeen();
    expect(armorClassSeen("half")).toBe(open + 2);
    expect(armorClassSeen("three-quarters")).toBe(open + 5);
  });

  it("adds the same to Dexterity saves against an effect from another zone", () => {
    const save = (cover?: "half" | "three-quarters"): number => {
      const fight = new Fight(partyWithSpells(["spell:web"], { 2: 1 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: withCover(cover) });
      fight.rolls([2]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:web", slotLevel: 2, targetIds: ["goblin-a"] });
      const declared = fight.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
      return Object.values(declared?.resolution.checks ?? {})[0]?.spec.modifier ?? 0;
    };
    expect(save("half")).toBe(save() + 2);
  });
});

describe("Hide", () => {
  const spec: EncounterSpec = { ...skirmish, zones: skirmish.zones.map((zone) => (zone.id === "gate" ? { ...zone, cover: "half" as const } : zone)) };
  const state = (): CampaignState => {
    const base = partyOfThree();
    const mira = base.characters["c-mira"];
    if (mira === undefined) throw new Error("mira");
    return { ...base, characters: { ...base.characters, "c-mira": { ...mira, features: [...mira.features, "feature:hide", "feature:cunning-action"] as typeof mira.features } } };
  };
  const hidden = (fight: Fight): boolean => fight.combatant("c-mira").effects.some((effect) => effect.modifiers.some((modifier) => modifier.kind === "hidden"));

  it("hides a hero out of reach in a zone with cover; attacking gives them away, with advantage", () => {
    const fight = new Fight(state()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.run(alex, { kind: "combatUseFeature", combatantId: "c-mira", featureId: "feature:hide" });
    expect(hidden(fight)).toBe(true);
    fight.rolls([15, 15], [1, 1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const shot = fight.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
    expect(Object.values(shot?.resolution.checks ?? {})[0]?.spec.mode).toBe("advantage");
    expect(hidden(fight)).toBe(false);
  });

  it("is refused where there is nowhere to hide", () => {
    const fight = new Fight(state()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    expect(fight.reject(alex, { kind: "combatUseFeature", combatantId: "c-mira", featureId: "feature:hide" })).toEqual({ code: "notUsable" });
  });
});
