import { describe, expect, it } from "vitest";

import { sneakDice } from "../../../src/domain/campaign/engine/combat/attack-rules.js";
import { formatDiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import type { Combatant } from "../../../src/domain/campaign/combat/combat-state.js";

function rogueAt(level: number): Combatant {
  return { level, traits: [{ kind: "sneakAttack" }] } as unknown as Combatant;
}

describe("Sneak Attack's die count", () => {
  it("is null without the feature", () => {
    expect(sneakDice({ level: 5, traits: [] } as unknown as Combatant)).toBeNull();
    expect(sneakDice(undefined)).toBeNull();
  });

  it("scales with level: 1d6 at 1, one more die every two levels", () => {
    expect(formatDiceExpression(sneakDice(rogueAt(1))!)).toBe("1d6");
    expect(formatDiceExpression(sneakDice(rogueAt(2))!)).toBe("1d6");
    expect(formatDiceExpression(sneakDice(rogueAt(3))!)).toBe("2d6");
    expect(formatDiceExpression(sneakDice(rogueAt(5))!)).toBe("3d6");
    expect(formatDiceExpression(sneakDice(rogueAt(19))!)).toBe("10d6");
    expect(formatDiceExpression(sneakDice(rogueAt(20))!)).toBe("10d6");
  });
});
