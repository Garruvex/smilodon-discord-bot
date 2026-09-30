import { describe, expect, it } from "vitest";

import { heroCombatant, heroTraits } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { armorSpeedPenalty, hasStealthDisadvantage } from "../../../src/domain/campaign/engine/gear.js";
import { borin, ruleset } from "./campaign-fixtures.js";

const rules = ruleset();

describe("worn gear traits don't double-count a spare", () => {
  it("still adds a shield's AC bonus once when a spare copy is also carried", () => {
    const oneShield = heroTraits(borin, rules.content);
    expect(oneShield).toContainEqual({ kind: "armorClassBonus", amount: 2 });

    const spareShield = { ...borin, equipment: [...borin.equipment, "item:shield" as const] };
    const withSpare = heroTraits(spareShield, rules.content);
    expect(withSpare.filter((trait) => trait.kind === "armorClassBonus")).toEqual([{ kind: "armorClassBonus", amount: 2 }]);

    const combatant = heroCombatant(spareShield, rules.content, "gate", { hp: spareShield.maxHp, resources: { spellSlots: {}, featureUses: {} } });
    expect(combatant.armorClass).toBe(18); // 16 (chain mail) + 2 (one shield), not 20.
  });
});

describe("armor properties the engine now enforces", () => {
  it("costs 10 feet of speed when worn under the armor's Strength requirement", () => {
    const weak = { ...borin, abilityScores: { ...borin.abilityScores, str: 10 } }; // Chain mail requires 13.
    expect(armorSpeedPenalty(weak, rules.content)).toBe(10);
    const combatant = heroCombatant(weak, rules.content, "gate", { hp: weak.maxHp, resources: { spellSlots: {}, featureUses: {} } });
    expect(combatant.speed).toBe(20); // 30 - 10.
  });

  it("costs nothing when the wearer meets the requirement", () => {
    expect(armorSpeedPenalty(borin, rules.content)).toBe(0); // Borin's STR 16 meets chain mail's 13.
    expect(heroCombatant(borin, rules.content, "gate", { hp: borin.maxHp, resources: { spellSlots: {}, featureUses: {} } }).speed).toBe(30);
  });

  it("flags Stealth disadvantage for chain mail but not leather", () => {
    expect(hasStealthDisadvantage(borin, rules.content)).toBe(true);
    const leatherOnly = { ...borin, equipment: ["item:leather-armor" as const] };
    expect(hasStealthDisadvantage(leatherOnly, rules.content)).toBe(false);
  });
});
