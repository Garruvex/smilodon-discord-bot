import { describe, expect, it } from "vitest";

import { alex, jamie, kinds } from "./campaign-fixtures.js";
import { startedFight } from "./combat-fixtures.js";

// Mira (20) then Borin (15), who wears chain mail and carries a shield.
const borinsTurn = () => startedFight().run(alex, { kind: "endTurn", combatantId: "c-mira" });

describe("a shield in a fight", () => {
  it("comes off as an action, lowering armor class, and goes back on the same way", () => {
    const fight = borinsTurn();
    const before = fight.combatant("c-borin").armorClass;
    const off = fight.run(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:shield", on: false });
    expect(off.combatant("c-borin").armorClass).toBe(before - 2);
    expect(off.combatant("c-borin").budget.action).toBe(false);
    expect(off.state.characters["c-borin"]?.worn).not.toContain("item:shield");
    expect(kinds(off.events).slice(-3)).toEqual(["wornChanged", "gearChanged", "actionTaken"]);
    // The action is spent: nothing more this turn until the next.
    expect(off.reject(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:shield", on: true })).toEqual({ code: "noActionLeft" });
  });

  it("puts it back on in a later turn", () => {
    const off = borinsTurn().run(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:shield", on: false });
    const later = off.run(jamie, { kind: "endTurn", combatantId: "c-borin" }).rolls([2, 2]);
    expect(later.current).toBe("c-mira");
    const back = later.run(alex, { kind: "endTurn", combatantId: "c-mira" }).run(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:shield", on: true });
    expect(back.state.characters["c-borin"]?.worn).toContain("item:shield");
  });

  it("refuses the wrong item, the wrong state, and someone else's turn", () => {
    const fight = borinsTurn();
    expect(fight.reject(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:chain-mail", on: false })).toEqual({ code: "notWearable" });
    expect(fight.reject(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:shield", on: true })).toEqual({ code: "alreadyWorn" });
    expect(fight.reject(jamie, { kind: "combatShield", combatantId: "c-borin", itemId: "item:buckler", on: true })).toEqual({ code: "notWearable" });
    expect(fight.reject(alex, { kind: "combatShield", combatantId: "c-borin", itemId: "item:shield", on: false })).toEqual({ code: "notYourCharacter" });
  });
});
