import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { attackMode } from "../../../src/domain/campaign/engine/combat/resolution.js";
import { alex, jamie, organizer } from "./campaign-fixtures.js";
import type { ContentId } from "../../../src/domain/campaign/rules/content-id.js";
import { conditionLookup, conditionsOf } from "../../../src/domain/campaign/effects/effect-queries.js";
import { ruleset } from "./campaign-fixtures.js";
import { appliedCondition } from "./effect-fixtures.js";
import { Fight } from "./combat-fixtures.js";

const lookup = conditionLookup(ruleset().content);

// A giant wolf spider already on the party's doorstep.
const webbed: EncounterSpec = {
  id: "enc-spider",
  zones: [{ id: "gate", name: "Gate" }],
  edges: [],
  partyZoneId: "gate",
  monsters: [{ monsterId: "monster:giant-wolf-spider", zoneId: "gate", npcId: null, fleeBelowHpFraction: null }],
};

describe("poisoned and frightened", () => {
  it("poisons a hero who fails the CON save against a spider's bite", () => {
    // Initiative: Mira 20, Borin 15, spider 5. The spider bites Mira (AC 14) with a 15,
    // then Mira rolls a 2 on her CON save (DC 11).
    const fight = new Fight().rolls([20, 15, 5]).run(organizer, { kind: "startEncounter", spec: webbed });
    fight.rolls([15, 2], [3]).run(alex, { kind: "endTurn", combatantId: "c-mira" }).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    expect(conditionsOf(fight.combatant("c-mira"), lookup)).toContain("condition:poisoned");
    expect(conditionsOf(fight.combatant("c-borin"), lookup)).not.toContain("condition:poisoned");
  });

  it("gives a poisoned or frightened attacker disadvantage, once however many apply", () => {
    const fight = new Fight().rolls([20, 15, 5]).run(organizer, { kind: "startEncounter", spec: webbed });
    const { encounter } = fight;
    const mira = fight.combatant("c-mira");
    const spider = fight.combatant("giant-wolf-spider");
    const modeWith = (conditions: readonly ContentId<"condition">[]): string =>
      attackMode(encounter, { ...mira, effects: conditions.map((condition) => appliedCondition(condition)) }, spider, false, false, lookup).mode;
    expect(modeWith([])).toBe("normal");
    expect(modeWith(["condition:poisoned"])).toBe("disadvantage");
    expect(modeWith(["condition:frightened"])).toBe("disadvantage");
    expect(modeWith(["condition:poisoned", "condition:frightened"])).toBe("disadvantage");
  });
});
