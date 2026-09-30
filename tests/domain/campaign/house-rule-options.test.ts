import { describe, expect, it } from "vitest";

import { parseDiceExpression, type DiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import { rollExpression } from "../../../src/domain/campaign/dice/roll.js";
import { resultMatchesSpec, type RollSpec } from "../../../src/domain/campaign/dice/roll-spec.js";
import { criticalHits, houseRuleOptions, itemTrading, resolveHouseRules } from "../../../src/domain/campaign/rules/house-rules.js";
import { alex, jamie, newCampaign, reject, ruleset, run } from "./campaign-fixtures.js";
import { startedFight } from "./combat-fixtures.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";

function dice(text: string): DiceExpression {
  const expression = parseDiceExpression(text);
  if (expression === null) throw new Error(`Not a dice expression: ${text}`);
  return expression;
}

describe("the house-rule option list", () => {
  it("has a default for every option that is one of its values, and rejects anything else", () => {
    for (const option of houseRuleOptions) expect(option.values).toContain(option.defaultValue);
    expect(resolveHouseRules({ "critical-hits": "max-first-die" }).option(criticalHits)).toBe("max-first-die");
    expect(resolveHouseRules({}).option(criticalHits)).toBe("double-dice");
    expect(() => resolveHouseRules({ "critical-hits": "triple" })).toThrow('does not allow "triple"');
  });
});

describe("critical hits: max first die", () => {
  const damage = dice("2d6+3");

  it("makes the first die its maximum and rolls the rest once, with no doubling", () => {
    const source = new SeededRandomSource(7);
    const roll = rollExpression(damage, source, { critical: true, criticalRule: "max-first-die" });
    expect(roll.expression).toEqual(damage);
    expect(roll.terms[0]?.values).toHaveLength(2);
    expect(roll.terms[0]?.values[0]).toBe(6);
    expect(roll.total).toBe(6 + (roll.terms[0]?.values[1] ?? 0) + 3);
    // Not a critical: nothing changes.
    expect(rollExpression(damage, new SeededRandomSource(7), { critical: false, criticalRule: "max-first-die" }).terms[0]?.values[0]).not.toBeUndefined();
  });

  it("uses no randomness for the maximum die, so the rest of the stream is unchanged", () => {
    const plain = rollExpression(dice("1d6"), new SeededRandomSource(3));
    const twoDice = rollExpression(dice("2d6"), new SeededRandomSource(3), { critical: true, criticalRule: "max-first-die" });
    expect(twoDice.terms[0]?.values[1]).toBe(plain.terms[0]?.values[0]);
  });

  it("is checked when a saved result is matched to its request", () => {
    const spec: RollSpec = { kind: "dice", expression: damage, critical: true, criticalRule: "max-first-die" };
    const good = { kind: "dice", roll: rollExpression(damage, new SeededRandomSource(1), { critical: true, criticalRule: "max-first-die" }) } as const;
    expect(resultMatchesSpec(good, spec)).toBe(true);
    // A doubled roll, or a first die that is not the maximum, is not this request's result.
    const doubled = { kind: "dice", roll: rollExpression(damage, new SeededRandomSource(1), { critical: true }) } as const;
    expect(resultMatchesSpec(doubled, spec)).toBe(false);
    const low = { kind: "dice", roll: { ...good.roll, terms: [{ sides: 6, values: [1, 2] }], total: 6 } } as const;
    expect(resultMatchesSpec(low, spec)).toBe(false);
    // Under the default rule the same request expects doubling.
    expect(resultMatchesSpec(doubled, { kind: "dice", expression: damage, critical: true })).toBe(true);
  });

  it("changes a fight: the damage request carries the rule, and the hit deals the maximum first die", () => {
    const plain = startedFight().rolls([20], [1, 1]);
    plain.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const doubled = plain.requests.find((request) => request.kind === "roll" && request.spec.kind === "dice" && request.spec.critical);
    expect(doubled).toMatchObject({ spec: { critical: true } });
    expect(doubled?.kind === "roll" && doubled.spec.kind === "dice" ? doubled.spec.criticalRule : "x").toBeUndefined();

    const house = startedFight(undefined, ruleset({ "critical-hits": "max-first-die" })).rolls([20], [1]);
    house.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const request = house.requests.find((entry) => entry.kind === "roll" && entry.spec.kind === "dice" && entry.spec.critical);
    expect(request?.kind === "roll" && request.spec.kind === "dice" ? request.spec.criticalRule : undefined).toBe("max-first-die");
    const rolled = house.events.find((event) => event.kind === "effectRolled");
    // The shortbow's 1d6 is its maximum (6) plus 3.
    expect(rolled).toMatchObject({ result: { roll: { total: 9 } }, value: 9 });
  });
});

describe("item trading: off", () => {
  const offer = { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null } as const;

  it("refuses to hand an item to another hero, while the default table allows it", () => {
    const off = ruleset({ [itemTrading.id]: "off" });
    expect(reject(newCampaign(), alex, offer, { rules: off })).toEqual({ code: "tradingOff" });
    expect(run(newCampaign(), alex, offer).events).toHaveLength(1);
  });

  it("still lets heroes use the party stash", () => {
    const off = ruleset({ [itemTrading.id]: "off" });
    const stashed = run(newCampaign(), alex, { kind: "stashItem", characterId: "c-mira", itemId: "item:shortbow" }, { rules: off });
    expect(stashed.state.stash).toContain("item:shortbow");
    const taken = run(stashed.state, jamie, { kind: "takeFromStash", characterId: "c-borin", itemId: "item:shortbow" }, { rules: off });
    expect(taken.state.characters["c-borin"]?.equipment).toContain("item:shortbow");
  });
});
