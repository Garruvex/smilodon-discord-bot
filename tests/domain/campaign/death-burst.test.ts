import { describe, expect, it } from "vitest";

import { organizer, partyWithSpells, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Death Burst: a monster that dies goes off, and everyone left in its zone makes a saving throw.

const mephit = { monsterId: "monster:ice-mephit", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;

function start(partyZoneId: string): Fight {
  const base = partyWithSpells(["spell:fireball"], { 3: 1 });
  const elspeth = base.characters["c-elspeth"];
  if (elspeth === undefined) throw new Error("elspeth");
  const strong = { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, level: 5 } } };
  return new Fight(strong).rolls([5, 4, 20, 3]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId, monsters: [mephit] } });
}

function foeId(fight: Fight): string {
  const id = Object.keys(fight.encounter?.combatants ?? {}).find((key) => key.includes("mephit"));
  if (id === undefined) throw new Error("no mephit");
  return id;
}

describe("Death Burst", () => {
  it("goes off when the monster dies, on everyone who stood in its zone", () => {
    const fight = start("courtyard");
    const foe = foeId(fight);
    // Fire is what an ice mephit fears: the fireball drops it (its own save fails; the heroes pass and take half).
    // The burst then catches the three heroes, who all fail, and its d8 comes up 4.
    fight
      .rolls([2, 20, 20, 20, 2, 2, 2], [...Array.from({ length: 8 }, () => 2), 4, 4, 4])
      .run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: [foe] });
    expect(fight.combatant(foe).condition).toBe("dead");
    const declared = fight.events.filter((event) => event.kind === "resolutionDeclared");
    expect(declared).toHaveLength(2);
    const burstAt = fight.events.findIndex((event) => event.kind === "resolutionDeclared" && event.resolution.actorId === foe);
    const struck = fight.events.slice(burstAt).flatMap((event) => (event.kind === "combatantHpChanged" && event.change < 0 ? [event.combatantId] : []));
    expect(struck.sort()).toEqual(["c-borin", "c-elspeth", "c-mira"]);
  });

  it("goes off once, and not at all when no one is left near it", () => {
    const fight = start("gate");
    const foe = foeId(fight);
    fight.rolls([2], Array.from({ length: 8 }, () => 3)).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: [foe] });
    expect(fight.combatant(foe).condition).toBe("dead");
    expect(fight.events.filter((event) => event.kind === "resolutionDeclared")).toHaveLength(1);
    expect(fight.combatant(foe).resources.featureUses["trait:death-burst"]).toBe(0);
  });
});
