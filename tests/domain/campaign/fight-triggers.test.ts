import { describe, expect, it } from "vitest";

import type { EncounterSpec, EncounterTrigger, FightEffect } from "../../../src/domain/campaign/commands/campaign-command.js";
import { jamie, organizer, partyOfThree } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// A fight's authored beats: foes that arrive, a truce, and what follows a victory.

const goblin = { monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;
const hag = { monsterId: "monster:green-hag", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;

// Borin engages the first goblin and kills it with one blow.
function strike(spec: EncounterSpec): Fight {
  const fight = new Fight(partyOfThree()).rolls([5, 20, 4, ...spec.monsters.map(() => 3)]).run(organizer, { kind: "startEncounter", spec });
  fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" in fight.encounter.combatants ? "goblin-a" : "goblin" });
  return fight.rolls([15], [8, 8, 8]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a" in fight.encounter.combatants ? "goblin-a" : "goblin", weapon: "item:longsword" });
}

const withTriggers = (monsters: EncounterSpec["monsters"], triggers: readonly EncounterTrigger[], extra: Partial<EncounterSpec> = {}): EncounterSpec => ({
  ...skirmish,
  partyZoneId: "courtyard",
  monsters,
  triggers,
  ...extra,
});

describe("fight triggers", () => {
  it("brings new foes into the fight when enough of the first ones fall, and tells the table", () => {
    const fight = strike(withTriggers([goblin], [{ when: { kind: "foesDown", count: 1 }, effects: [{ kind: "announce", text: "A hag steps from the mist." }, { kind: "addMonsters", monsters: [hag] }] }]));
    expect(fight.encounter.status).toBe("active");
    expect(fight.encounter.triggersFired).toEqual([0]);
    const arrived = Object.values(fight.encounter.combatants).find((combatant) => combatant.source.kind === "monster" && combatant.source.monsterId === "monster:green-hag");
    expect(arrived).toMatchObject({ side: "foes", condition: "active" });
    expect(fight.encounter.order).toContain(arrived?.id);
    expect(fight.requests).toContainEqual({ kind: "deliver", delivery: { kind: "fightNotice", encounterId: "enc-1", text: "A hag steps from the mist." } });
  });

  it("fires each trigger only once", () => {
    const fight = strike(withTriggers([goblin, goblin], [{ when: { kind: "foesDown", count: 1 }, effects: [{ kind: "addMonsters", monsters: [goblin] }] }]));
    const goblins = Object.values(fight.encounter.combatants).filter((combatant) => combatant.side === "foes");
    expect(goblins).toHaveLength(3);
    expect(fight.encounter.triggersFired).toEqual([0]);
  });

  it("ends the fight in the party's favour on a truce, with the rest of the foes left standing", () => {
    const truce: readonly FightEffect[] = [{ kind: "setFlag", flag: "hag-parley", value: 1 }];
    const fight = strike(withTriggers([goblin, goblin], [{ when: { kind: "foesDown", count: 1 }, effects: [...truce, { kind: "endFight" }] }], { gold: 40 }));
    expect(fight.encounter.status).toBe("ended");
    expect(fight.encounter.outcome).toBe("victory");
    expect(fight.state.flags).toEqual({ "hag-parley": 1 });
    expect(fight.state.gold).toBe(40);
    expect(fight.events.some((event) => event.kind === "experienceAwarded")).toBe(true);
    expect(Object.values(fight.encounter.combatants).filter((combatant) => combatant.side === "foes" && combatant.condition === "active")).toHaveLength(1);
  });

  it("applies the victory effects: a reward, a flag, and the next scene", () => {
    const fight = strike(
      withTriggers([goblin], [], {
        onVictory: [
          { kind: "grantReward", rewardId: "enc-1:victory:0", gold: 60, items: [] },
          { kind: "setFlag", flag: "field-won", value: 1 },
          { kind: "transitionScene", sceneId: "scene:hag-hut" },
        ],
      }),
    );
    expect(fight.encounter.outcome).toBe("victory");
    expect(fight.state.gold).toBe(60);
    expect(fight.state.flags).toMatchObject({ "field-won": 1, "reward:enc-1:victory:0": 1 });
    expect(fight.state.sceneId).toBe("scene:hag-hut");
  });

  it("does not run the victory effects when the party loses", () => {
    const fight = new Fight(partyOfThree()).rolls([5, 20, 4, 3]).run(organizer, { kind: "startEncounter", spec: withTriggers([goblin], [], { onVictory: [{ kind: "setFlag", flag: "field-won", value: 1 }] }) });
    expect(fight.state.flags).toBeUndefined();
  });
});
