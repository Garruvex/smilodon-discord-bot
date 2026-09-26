import { describe, expect, it } from "vitest";

import { dice } from "../../../src/domain/campaign/dice/dice-expression.js";
import { capabilities, type Capability } from "../../../src/domain/campaign/rules/capabilities.js";
import {
  defineCondition,
  defineSpell,
  type ContentDefinition,
} from "../../../src/domain/campaign/rules/content-definitions.js";
import type { ContentId } from "../../../src/domain/campaign/rules/content-id.js";
import {
  ContentRegistryBuilder,
  ContentValidationError,
  type Glossary,
} from "../../../src/domain/campaign/rules/content-registry.js";

const allCapabilities: ReadonlySet<Capability> = new Set(capabilities);

const prone = defineCondition({ id: "condition:prone", source: "Test", includes: [] });
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

  it("requires a display name in every glossary and flags unknown glossary entries", () => {
    const zh: Glossary = { language: "zh-TW", names: { "condition:prone": "倒地", "spell:gone": "消失" } };
    const problems = problemsOf(() => build([prone, trip], { glossaries: [glossaryFor("en", [prone, trip]), zh] }));
    expect(problems).toEqual([
      "spell:trip: no zh-TW display name.",
      'zh-TW glossary names unknown content "spell:gone".',
    ]);
  });

  it("reports every problem in one error", () => {
    const unsourced = defineCondition({ id: "condition:dazed", source: " ", includes: ["condition:stunned"] });
    const problems = problemsOf(() => build([unsourced], { glossaries: [{ language: "en", names: {} }] }));
    expect(problems).toEqual([
      "condition:dazed: missing source attribution.",
      'condition:dazed: references missing content "condition:stunned".',
      "condition:dazed: no en display name.",
    ]);
  });
});
