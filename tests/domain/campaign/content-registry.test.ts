import { describe, expect, it } from "vitest";

import { dice, plus } from "../../../src/domain/campaign/dice/dice-expression.js";
import { capabilities, type Capability } from "../../../src/domain/campaign/rules/capabilities.js";
import {
  defineClass,
  defineCondition,
  defineMonster,
  defineShield,
  defineSpell,
  defineWeapon,
  type ContentDefinition,
} from "../../../src/domain/campaign/rules/content-definitions.js";
import type { ContentId } from "../../../src/domain/campaign/rules/content-id.js";
import {
  ContentRegistryBuilder,
  ContentValidationError,
  type Glossary,
} from "../../../src/domain/campaign/rules/content-registry.js";

const allCapabilities: ReadonlySet<Capability> = new Set(capabilities);

const prone = defineCondition({ id: "condition:prone", source: "Test", includes: [], modifiers: [] });
const trip = defineSpell({
  id: "spell:trip",
  source: "Test",
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "enemy", count: 1 },
  concentration: false,
  plan: () => ({
    check: { kind: "savingThrow", ability: "dex" },
    onLand: [{ kind: "applyCondition", target: "target", condition: "condition:prone", duration: { kind: "instant" } }],
    onAvoid: [],
  }),
});

function glossaryFor(language: string, definitions: readonly ContentDefinition[]): Glossary {
  return { language, names: Object.fromEntries(definitions.map((definition) => [definition.id, definition.id])) };
}

function build(
  definitions: readonly ContentDefinition[],
  options: { capabilities?: ReadonlySet<Capability>; glossaries?: readonly Glossary[] } = {},
): ReturnType<ContentRegistryBuilder["build"]> {
  return new ContentRegistryBuilder("test", "1").add(definitions).build({
    capabilities: options.capabilities ?? allCapabilities,
    glossaries: options.glossaries ?? [glossaryFor("en", definitions)],
  });
}

function problemsOf(action: () => unknown): readonly string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof ContentValidationError) return error.problems;
    throw error;
  }
  throw new Error("Expected the build to fail.");
}

describe("ContentRegistryBuilder", () => {
  it("builds valid content and looks it up by ID and kind", () => {
    const content = build([prone, trip]);
    expect(content.get("spell:trip").level).toBe(1);
    expect(content.find("condition:prone")).toBe(content.get("condition:prone"));
    expect(content.find("condition:missing")).toBeUndefined();
    expect(content.all("condition").map((definition) => definition.id)).toEqual(["condition:prone"]);
  });

  it("seals content so it cannot be changed after build", () => {
    const content = build([prone, trip]);
    const sealed = content.get("condition:prone");
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.includes)).toBe(true);
  });

  it("reports duplicate IDs and IDs that do not match their kind", () => {
    const mislabeled = { ...prone, id: "spell:prone" as ContentId<"condition"> };
    const problems = problemsOf(() => build([prone, prone, mislabeled]));
    expect(problems).toContain("condition:prone: defined more than once.");
    expect(problems).toContain('spell:prone: ID prefix does not match kind "condition".');
  });

  it("reports references to missing content, found by evaluating spell plans", () => {
    const problems = problemsOf(() => build([trip], { glossaries: [] }));
    expect(problems).toEqual(['spell:trip: references missing content "condition:prone".']);
  });

  it("derives required capabilities from the definition's shape", () => {
    const withoutSaves = new Set(capabilities.filter((capability) => capability !== "saving-throws"));
    const problems = problemsOf(() => build([prone, trip], { capabilities: withoutSaves }));
    expect(problems).toEqual(['spell:trip: requires engine capability "saving-throws", which is not available.']);
  });

  it("requires concentration for concentration spells", () => {
    const focus = defineSpell({ ...trip, id: "spell:focus", concentration: true });
    const withoutConcentration = new Set(capabilities.filter((capability) => capability !== "concentration"));
    const problems = problemsOf(() => build([prone, focus], { capabilities: withoutConcentration }));
    expect(problems).toEqual(['spell:focus: requires engine capability "concentration", which is not available.']);
  });

  it("reports a spell whose plan throws at some slot level", () => {
    const broken = defineSpell({
      ...trip,
      id: "spell:broken",
      plan: ({ slotLevel }) => ({
        check: null,
        onLand: [{ kind: "heal", target: "target", amount: dice(slotLevel * 20, 8) }],
        onAvoid: [],
      }),
    });
    const problems = problemsOf(() => build([broken]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^spell:broken: definition could not be evaluated/);
  });

  it("rejects a spell level outside 0-9, which castableSlotLevels would otherwise silently sample zero plans from", () => {
    const tooHigh = defineSpell({ ...trip, id: "spell:too-high", level: 10 });
    const problems = problemsOf(() => build([tooHigh]));
    expect(problems).toEqual(["spell:too-high: spell level 10 is out of range (0-9)."]);

    // Even one whose plan always throws must still be caught: at an
    // out-of-range level, samplePlans would never call it at all.
    const brokenAndTooHigh = defineSpell({
      ...trip,
      id: "spell:broken-too-high",
      level: 10,
      plan: () => {
        throw new Error("never called");
      },
    });
    expect(problemsOf(() => build([brokenAndTooHigh]))).toEqual(["spell:broken-too-high: spell level 10 is out of range (0-9)."]);
  });

  it("rejects a monster attack that references a non-weapon item", () => {
    const shield = defineShield({ id: "item:test-shield", source: "Test", armorClassBonus: 2 });
    const badMonster = defineMonster({
      id: "monster:confused",
      source: "Test",
      armorClass: 10,
      maxHp: 5,
      xp: 10,
      speed: 30,
      abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      attacks: [{ weapon: "item:test-shield", toHit: 2, damage: dice(1, 4) }],
      tactic: "brute",
      traits: [],
    });
    const problems = problemsOf(() => build([shield, badMonster]));
    expect(problems).toEqual(['monster:confused: attack references "item:test-shield", which is not a weapon.']);
  });

  it("accepts a monster attack that references an actual weapon", () => {
    const club = defineWeapon({ id: "item:test-club", source: "Test", damage: dice(1, 4), damageType: "bludgeoning", range: { kind: "melee" }, finesse: false, natural: false });
    const monster = defineMonster({
      id: "monster:ordinary",
      source: "Test",
      armorClass: 10,
      maxHp: 5,
      xp: 10,
      speed: 30,
      abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      attacks: [{ weapon: "item:test-club", toHit: 2, damage: plus(dice(1, 4), 1) }],
      tactic: "brute",
      traits: [],
    });
    expect(() => build([club, monster])).not.toThrow();
  });

  it("resolves references out of a class's kits, features, and spellcasting, the same as any other content", () => {
    const club = defineWeapon({ id: "item:test-club", source: "Test", damage: dice(1, 4), damageType: "bludgeoning", range: { kind: "melee" }, finesse: false, natural: false });
    const brawler = defineClass({
      id: "class:brawler",
      source: "Test",
      hitDie: 10,
      savingThrows: ["str"],
      skillChoices: ["athletics"],
      skillCount: 1,
      expertiseCount: 0,
      features: ["feature:missing"],
      kits: [{ id: "starter", equipment: ["item:test-club", "item:also-missing"] }],
      spellcasting: null,
      suggested: ["str"],
      casterType: "none",
      spellcastingAbility: null,
      firstSpells: [],
      levelFeatures: {},
    });
    const problems = problemsOf(() => build([club, brawler]));
    expect(problems).toEqual([
      'class:brawler: references missing content "item:also-missing".',
      'class:brawler: references missing content "feature:missing".',
    ]);
  });

  it("requires a display name in every glossary and flags unknown glossary entries", () => {
    const zh: Glossary = { language: "zh-TW", names: { "condition:prone": "倒地", "spell:gone": "消失" } };
    const problems = problemsOf(() => build([prone, trip], { glossaries: [glossaryFor("en", [prone, trip]), zh] }));
    expect(problems).toEqual([
      "spell:trip: no zh-TW display name.",
      'zh-TW glossary names unknown content "spell:gone".',
    ]);
  });

  it("reports every problem in one error", () => {
    const unsourced = defineCondition({ id: "condition:dazed", source: " ", includes: ["condition:stunned"], modifiers: [] });
    const problems = problemsOf(() => build([unsourced], { glossaries: [{ language: "en", names: {} }] }));
    expect(problems).toEqual([
      "condition:dazed: missing source attribution.",
      'condition:dazed: references missing content "condition:stunned".',
      "condition:dazed: no en display name.",
    ]);
  });
});
