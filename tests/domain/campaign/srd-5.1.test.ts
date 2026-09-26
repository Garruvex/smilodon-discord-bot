import { describe, expect, it } from "vitest";

import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { cantripDiceCount } from "../../../src/domain/campaign/content/srd-5.1/spells/cantrips.js";
import { buildSrd51 } from "../../../src/domain/campaign/content/srd-5.1/index.js";
import { formatDiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import { milestone0Capabilities } from "../../../src/domain/campaign/rules/capabilities.js";
import type { Effect } from "../../../src/domain/campaign/rules/effects.js";

const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });

function amountOf(effect: Effect | undefined): string {
  if (effect?.kind === "heal" || effect?.kind === "damage") return formatDiceExpression(effect.amount);
  throw new Error(`Expected a heal or damage effect, got ${effect?.kind}.`);
}

describe("SRD 5.1 content", () => {
  it("builds with complete en and zh-TW glossaries against the milestone 0 capabilities", () => {
    expect(content.rulesetId).toBe("srd-5.1");
    expect(content.all("spell").length).toBeGreaterThan(0);
  });

  it("makes Unconscious include Incapacitated and Prone", () => {
    expect(content.get("condition:unconscious").includes).toEqual(["condition:incapacitated", "condition:prone"]);
  });

  it("scales Cure Wounds by slot level and adds the spellcasting modifier", () => {
    const cureWounds = content.get("spell:cure-wounds");
    expect(amountOf(cureWounds.plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 }).onLand[0])).toBe("1d8 + 3");
    expect(amountOf(cureWounds.plan({ slotLevel: 3, casterLevel: 5, spellcastingModifier: 3 }).onLand[0])).toBe("3d8 + 3");
  });

  it("makes Healing Word a bonus action at 60 feet", () => {
    const healingWord = content.get("spell:healing-word");
    expect(healingWord.castingTime).toBe("bonus-action");
    expect(healingWord.range).toEqual({ kind: "feet", feet: 60 });
    expect(amountOf(healingWord.plan({ slotLevel: 2, casterLevel: 3, spellcastingModifier: 2 }).onLand[0])).toBe("2d4 + 2");
  });

  it("makes Bless a concentration spell adding 1d4 to attacks and saves", () => {
    const bless = content.get("spell:bless");
    expect(bless.concentration).toBe(true);
    expect(bless.targeting).toEqual({ relation: "creature", count: 3, countPerHigherSlot: 1 });
    expect(bless.plan({ slotLevel: 1, casterLevel: 1, spellcastingModifier: 3 }).onLand[0]).toMatchObject({
      kind: "bonusDie",
      appliesTo: ["attack", "save"],
      duration: { kind: "rounds", count: 10 },
    });
  });

  it("makes Sacred Flame a Dexterity save that scales at levels 5, 11, and 17", () => {
    const sacredFlame = content.get("spell:sacred-flame");
    const plan = sacredFlame.plan({ slotLevel: 0, casterLevel: 1, spellcastingModifier: 3 });
    expect(plan.check).toEqual({ kind: "savingThrow", ability: "dex" });
    expect(plan.onAvoid).toEqual([]);
    expect([1, 4, 5, 10, 11, 16, 17, 20].map(cantripDiceCount)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});
