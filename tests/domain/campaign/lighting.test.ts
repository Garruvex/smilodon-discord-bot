import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { conditionLookup } from "../../../src/domain/campaign/effects/effect-queries.js";
import { attackMode } from "../../../src/domain/campaign/engine/combat/attack-rules.js";
import { alex, jamie, organizer, partyOfThree, partyWithSpells, ruleset, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Dark zones: a creature that cannot see in the dark fights at disadvantage in or against one.

const dark: EncounterSpec = { ...skirmish, zones: [{ id: "gate", name: "Gate" }, { id: "courtyard", name: "Courtyard", lighting: "dark" }] };
const lookup = conditionLookup(ruleset().content);
const start = (spec: EncounterSpec): Fight => new Fight(partyOfThree()).rolls([5, 20, 3, 2, 1]).run(organizer, { kind: "startEncounter", spec });

describe("dark zones", () => {
  it("give a creature without darkvision disadvantage against a target in them, and none in the light", () => {
    for (const [spec, expected] of [[dark, "disadvantage"], [skirmish, "normal"]] as const) {
      const fight = start(spec);
      const mira = fight.combatant("c-mira");
      expect(mira.traits.some((trait) => trait.kind === "darkvision")).toBe(false);
      const mode = attackMode(fight.encounter, mira, fight.combatant("goblin-a"), true, false, lookup).mode;
      expect(mode).toBe(expected);
    }
  });

  it("leaves a creature that sees in the dark unhindered", () => {
    const fight = start(dark);
    const goblin = fight.combatant("goblin-a");
    expect(goblin.traits).toContainEqual({ kind: "darkvision", feet: 60 });
    expect(attackMode(fight.encounter, goblin, fight.combatant("c-mira"), false, false, lookup).mode).toBe("normal");
  });
});

describe("Darkness and Light", () => {
  it("Darkness darkens the caster's zone and Light brings it back", () => {
    const fight = new Fight(partyWithSpells(["spell:darkness", "spell:light"], { 2: 1 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    const lighting = (): string | undefined => fight.encounter.zones.find((zone) => zone.id === "gate")?.lighting;
    expect(lighting()).toBeUndefined();
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:darkness", slotLevel: 2, targetIds: ["c-elspeth"] });
    expect(lighting()).toBe("dark");
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 12 }, () => 1), Array.from({ length: 12 }, () => 1)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:light", slotLevel: 0, targetIds: ["c-elspeth"] });
    expect(lighting()).toBe("bright");
  });
});
