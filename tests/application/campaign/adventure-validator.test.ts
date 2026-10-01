import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { adventurePreview, routeWarnings, validateAdventure } from "../../../src/application/campaign/adventures/adventure-validator.js";
import { rehearseEncounter } from "../../../src/application/campaign/adventures/adventure-smoke.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";
import { starter } from "./campaign-rig.js";

const { content } = ruleset();
const yamlOf = (language: "en" | "zh-TW"): string => readFileSync(new URL(`../../../assets/campaign/adventures/moonlit-ruins/${language}.yaml`, import.meta.url), "utf8").replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));

describe("rehearsing a fight", () => {
  it("plays the starter adventure's fight to an end with the adventure's own heroes", () => {
    const encounter = starter.en.bible.encounters[0];
    if (encounter === undefined) throw new Error("encounter");
    for (const seed of [1, 2, 3]) {
      const result = rehearseEncounter(starter.en, encounter, content, seed);
      expect(result.problem, `seed ${seed}`).toBeNull();
      expect(["victory", "defeat"]).toContain(result.outcome);
      expect(result.rounds).toBeGreaterThan(0);
    }
  });
});

describe("checking an adventure", () => {
  it("passes both editions of the bundled adventure", () => {
    for (const language of ["en", "zh-TW"] as const) {
      const report = validateAdventure(yamlOf(language), content);
      expect(report.errors, language).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.rehearsals).toHaveLength(starter[language].bible.encounters.length * 3);
    }
  });

  it("says what is wrong with a file that is not an adventure, all at once", () => {
    expect(validateAdventure("not: [valid", content).errors[0]).toContain("Unable to parse YAML");
    const missing = validateAdventure("id: x\n", content);
    expect(missing.ok).toBe(false);
    expect(missing.errors.length).toBeGreaterThan(3);
    expect(missing.document).toBeNull();
  });

  it("refuses monsters, items and spells the ruleset does not have, before any rehearsal", () => {
    const source = yamlOf("en").replace("monster:goblin", "monster:beholder").replace("item:longsword", "item:sword-of-nonexistence");
    const report = validateAdventure(source, content);
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("encounter:watchtower-scouts uses monster:beholder, which the ruleset does not have.");
    expect(report.errors.some((error) => error.includes("item:sword-of-nonexistence"))).toBe(true);
    expect(report.rehearsals).toEqual([]);
  });

  it("refuses references to things the adventure does not define", () => {
    const report = validateAdventure(yamlOf("en").replace("startScene: scene:", "startScene: scene:nowhere-"), content);
    expect(report.ok).toBe(false);
    expect(report.errors.some((error) => error.includes("is not a scene"))).toBe(true);
  });

  it("refuses an adventure over its limits", () => {
    const huge = `${yamlOf("en")}\n# ${"x".repeat(210_000)}`;
    expect(validateAdventure(huge, content).errors).toEqual(["The file is larger than 200 KB."]);
    const longNote = yamlOf("en").replace(/premise: .*/, `premise: ${"word ".repeat(1_000)}`);
    expect(validateAdventure(longNote, content).errors[0]).toContain("longer than 4000 characters");
  });

  it("shows a preview with nothing from the DM's side of the page", () => {
    const preview = adventurePreview(starter.en);
    expect(preview.title).toBe(starter.en.bible.title);
    expect(preview.heroes.map((hero) => hero.className)).toEqual(["fighter", "rogue", "cleric"]);
    expect(preview.encounters[0]?.monsters.length).toBeGreaterThan(0);
    const text = JSON.stringify(preview);
    for (const scene of starter.en.bible.scenes) expect(text).not.toContain(scene.dmNotes);
    for (const npc of starter.en.bible.npcs) expect(text).not.toContain(npc.secret);
    expect(text).not.toContain(starter.en.bible.dmOverview);
  });
});

describe("fights that cannot be played", () => {
  it("catches a fight the engine refuses to start, naming the fight", () => {
    // Foes in a zone with no way to it: the map is not connected.
    const source = yamlOf("en").replace("      - { from: nave, to: altar, feet: 15 }\n", "");
    const report = validateAdventure(source, content);
    expect(report.ok).toBe(false);
    expect(report.errors.some((error) => error.startsWith("encounter:chapel-fight cannot be played:"))).toBe(true);
    expect(report.document).not.toBeNull();
  });

  it("warns, without refusing, when the adventure's own heroes lose every rehearsal", () => {
    // Twenty wolves in the doorway.
    const wolves = Array.from({ length: 20 }, () => "      - { monsterId: monster:wolf, zoneId: doorway }").join("\n");
    const source = yamlOf("en").replace(/ {4}monsters:\n {6}- \{ monsterId: monster:wolf, zoneId: nave \}\n(?: {6}- \{[^\n]*\n){3}/, `    monsters:\n${wolves}\n`);
    const report = validateAdventure(source, content);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toContain("encounter:chapel-fight defeated the adventure's own heroes in every rehearsal; it may be too hard.");
  });
});

describe("checking the routes between scenes", () => {
  const [first, second, third] = starter.en.bible.scenes;
  if (first === undefined || second === undefined || third === undefined) throw new Error("scenes");
  const withScenes = (scenes: typeof starter.en.bible.scenes): typeof starter.en => ({ ...starter.en, bible: { ...starter.en.bible, startScene: first.id, scenes } });

  it("has nothing to say about an adventure that lists no exits", () => {
    expect(routeWarnings(withScenes([first, second, third]))).toEqual([]);
  });

  it("flags a scene nothing leads to, a scene with no way out, and a one-way exit", () => {
    const warnings = routeWarnings(withScenes([{ ...first, exits: [{ to: second.id }] }, { ...second, exits: [] }, { ...third, exits: [{ to: first.id }] }]));
    expect(warnings).toContain(`${third.id} cannot be reached from the start scene by its exits.`);
    expect(warnings).toContain(`${second.id} has no way out; the party would be stuck there.`);
  });

  it("flags an exit that cannot be undone, but not one that can", () => {
    const oneWay = routeWarnings(withScenes([{ ...first, exits: [{ to: second.id }] }, { ...second, exits: [{ to: third.id }] }, { ...third, exits: [{ to: second.id }] }]));
    expect(oneWay).toContain(`${first.id} leads to ${second.id}, but there is no way back.`);
    const both = routeWarnings(withScenes([{ ...first, exits: [{ to: second.id }] }, { ...second, exits: [{ to: first.id }, { to: third.id }] }, { ...third, exits: [{ to: second.id }] }]));
    expect(both).toEqual([]);
  });
});
