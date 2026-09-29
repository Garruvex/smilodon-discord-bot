import { describe, expect, it } from "vitest";
import { armorClassFrom, heroCombatant, unarmoredModifier } from "../../../src/domain/campaign/combat/combatant-profile.js";
import { traitsOf } from "../../../src/domain/campaign/rules/content-definitions.js";
import { hasSaveAdvantage, type SaveContext, type Trait } from "../../../src/domain/campaign/rules/traits.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign, organizer, partyOfThree, ruleset, run } from "./campaign-fixtures.js";

const content = ruleset().content;
const featureTraits = (id: `feature:${string}`): readonly Trait[] => traitsOf(content.get(id));
const nothing: SaveContext = { conditions: [], damageTypes: [], magic: false };

describe("Unarmored Defense", () => {
  const scores = { str: 10, dex: 14, con: 16, int: 8, wis: 12, cha: 10 };
  it("adds Constitution for a barbarian and Wisdom for a monk, but only without armor", () => {
    const barbarian = featureTraits("feature:rage");
    expect(unarmoredModifier(barbarian, scores)).toBe(3);
    expect(armorClassFrom(barbarian, 2, 3)).toBe(15);
    expect(unarmoredModifier(featureTraits("feature:martial-arts"), scores)).toBe(1);
    expect(armorClassFrom([...barbarian, { kind: "armor", baseArmorClass: 11, dexterityCap: null }], 2, 3)).toBe(13);
    expect(unarmoredModifier([], scores)).toBe(0);
  });
});

describe("Danger Sense", () => {
  it("gives advantage on Dexterity saves only", () => {
    const traits = featureTraits("feature:danger-sense");
    expect(hasSaveAdvantage(traits, "dex", nothing)).toBe(true);
    expect(hasSaveAdvantage(traits, "wis", nothing)).toBe(false);
  });
});

describe("speed bonuses and Rage by level", () => {
  const withFeatures = (features: readonly string[]): CampaignState => {
    const base = newCampaign();
    const hero = base.characters["c-borin"];
    if (hero === undefined) throw new Error("fixture");
    return { ...base, characters: { ...base.characters, "c-borin": { ...hero, features: [...hero.features, ...features] as typeof hero.features } } };
  };

  it("adds Fast Movement to a hero's speed", () => {
    const plain = newCampaign().characters["c-borin"];
    const fast = withFeatures(["feature:fast-movement"]).characters["c-borin"];
    if (plain === undefined || fast === undefined) throw new Error("fixture");
    const status = { hp: plain.maxHp, resources: { spellSlots: {}, featureUses: {} } };
    expect(heroCombatant(fast, content, "gate", status).speed).toBe(heroCombatant(plain, content, "gate", status).speed + 10);
  });

  it("gives a barbarian more rages and a bigger bonus as levels go up", () => {
    const rage = content.get("feature:rage");
    if (rage.kind !== "feature" || rage.action === null || !("recharge" in rage.action.uses)) throw new Error("rage");
    expect(rage.action.uses.perLevel?.(1)).toBe(2);
    expect(rage.action.uses.perLevel?.(3)).toBe(3);
    expect(rage.action.uses.perLevel?.(6)).toBe(4);
    expect(rage.action.uses.perLevel?.(17)).toBe(6);
    const bonus = (level: number): number => {
      const modifiers = rage.action?.plan({ level }).onLand.flatMap((effect) => (effect.kind === "applyModifiers" ? effect.modifiers : [])) ?? [];
      return modifiers.flatMap((modifier) => (modifier.kind === "meleeDamageBonus" ? [modifier.amount] : []))[0] ?? 0;
    };
    expect([bonus(1), bonus(9), bonus(16)]).toEqual([2, 3, 4]);
  });
});

describe("Natural and Arcane Recovery", () => {
  it("returns slots on a short rest, once until the next long rest", () => {
    const base = partyOfThree();
    const hero = base.characters["c-elspeth"];
    if (hero === undefined) throw new Error("fixture");
    const sheet = { ...hero, level: 4, features: [...hero.features, "feature:circle-of-the-land"] as typeof hero.features, spellcasting: hero.spellcasting === null ? null : { ...hero.spellcasting, slots: { 1: 4, 2: 3 } } };
    const state: CampaignState = {
      ...base,
      characters: { ...base.characters, "c-elspeth": sheet },
      heroStatus: { ...base.heroStatus, "c-elspeth": { hp: sheet.maxHp, resources: { spellSlots: { 1: 0, 2: 0 }, featureUses: { "feature:circle-of-the-land": 1 } } } },
    };
    const rested = run(state, organizer, { kind: "takeRest", rest: "short" });
    // Half of level 4 is 2 combined levels: one second-level slot comes back.
    expect(rested.state.heroStatus["c-elspeth"]?.resources.spellSlots).toEqual({ 1: 0, 2: 1 });
    expect(rested.state.heroStatus["c-elspeth"]?.resources.featureUses["feature:circle-of-the-land"]).toBe(0);
    const again = run(rested.state, organizer, { kind: "takeRest", rest: "short" });
    expect(again.state.heroStatus["c-elspeth"]?.resources.spellSlots).toEqual({ 1: 0, 2: 1 });
  });
});
