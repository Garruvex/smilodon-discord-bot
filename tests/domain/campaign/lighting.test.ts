import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { conditionLookup } from "../../../src/domain/campaign/effects/effect-queries.js";
import { attackMode } from "../../../src/domain/campaign/engine/combat/attack-rules.js";
import { organizer, partyOfThree, ruleset } from "./campaign-fixtures.js";
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
