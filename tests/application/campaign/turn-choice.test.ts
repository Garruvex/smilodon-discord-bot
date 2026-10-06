import { describe, expect, it } from "vitest";

import { combatCommand } from "../../../src/application/campaign/views/turn-choice.js";

const hero = "c-mira" as never;

describe("turning a turn choice into an engine command", () => {
  it("needs a target for an attack, and reads the weapon's mode from its prefix", () => {
    expect(combatCommand({ kind: "attack", weapon: "item:dagger" }, [])).toBeNull();
    expect(combatCommand({ kind: "attack", weapon: "item:dagger" }, ["m-1"])?.(hero)).toEqual({ kind: "combatAttack", combatantId: hero, targetId: "m-1", weapon: "item:dagger" });
    expect(combatCommand({ kind: "attack", weapon: "offhand:item:dagger" }, ["m-1"])?.(hero)).toMatchObject({ weapon: "item:dagger", offHand: true });
    expect(combatCommand({ kind: "attack", weapon: "nonlethal:item:club" }, ["m-1"])?.(hero)).toMatchObject({ weapon: "item:club", nonlethal: true });
  });

  it("casts at every target, and sends a teleport at the caster", () => {
    expect(combatCommand({ kind: "cast", spell: "spell:fire-bolt", slot: 0 }, [])).toBeNull();
    expect(combatCommand({ kind: "cast", spell: "spell:fire-bolt", slot: 0 }, ["a", "b"])?.(hero)).toMatchObject({ kind: "combatCast", targetIds: ["a", "b"] });
    expect(combatCommand({ kind: "teleport", spell: "spell:misty-step", slot: 2, zone: "z-2" }, [])?.(hero)).toMatchObject({ targetIds: [hero], zoneId: "z-2" });
  });

  it("has no command for the menu pages", () => {
    for (const kind of ["spells", "shapes", "more"] as const) expect(combatCommand({ kind, page: 0 }, [])).toBeNull();
    expect(combatCommand({ kind: "end" }, [])?.(hero)).toEqual({ kind: "endTurn", combatantId: hero });
  });
});
