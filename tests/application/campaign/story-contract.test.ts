import { describe, expect, it } from "vitest";

import { analyzeStoryContract } from "../../../src/application/campaign/adventures/story-contract.js";
import type { AdventureBible, BibleInteraction, BibleScene } from "../../../src/domain/campaign/adventure/adventure-bible.js";

// A small story is written as plain data; the contract is whether it can always be finished.
const scene = (id: string, extra: Partial<BibleScene> = {}): BibleScene => ({ id: id as BibleScene["id"], title: id, publicDescription: id, dmNotes: "", npcIds: [], ...extra });
const interaction = (id: string, sceneId: string, extra: Partial<BibleInteraction> = {}): BibleInteraction => ({
  id: `interaction:${id}` as BibleInteraction["id"], sceneId: sceneId as BibleInteraction["sceneId"], label: id, dmNotes: "",
  check: null, requires: {}, pay: 0, attempts: 1, onSuccess: [], onFailure: [], tiers: [], ...extra,
});
const story = (scenes: readonly BibleScene[], interactions: readonly BibleInteraction[] = []): AdventureBible => ({
  id: "test", version: "1", language: "en", title: "t", premise: "p", dmOverview: "d", startScene: scenes[0]?.id as AdventureBible["startScene"],
  scenes, npcs: [], encounters: [], clocks: [], clues: [], interactions,
});
const rules = (bible: AdventureBible): string[] => analyzeStoryContract(bible).filter((finding) => finding.severity === "error").map((finding) => finding.rule);

describe("the story contract", () => {
  it("accepts a story that always has a way on", () => {
    const bible = story([scene("scene:a", { exits: [{ to: "scene:b" as never }] }), scene("scene:b", { ending: true, exits: [] })]);
    expect(analyzeStoryContract(bible)).toEqual([]);
  });

  it("rejects a key locked behind its own door", () => {
    const bible = story(
      [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["key"] } }] }), scene("scene:b", { ending: true, exits: [] })],
      [interaction("take-key", "scene:b", { onSuccess: [{ kind: "set", flag: "key" }] })],
    );
    expect(rules(bible)).toContain("unreachable-scene");
  });

  it("rejects a requirement that nothing can ever satisfy", () => {
    const bible = story([scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["never-set"] } }] }), scene("scene:b", { ending: true, exits: [] })]);
    expect(rules(bible)).toContain("unsatisfiable-requirement");
  });

  it("rejects a scene with no way out that is not an ending", () => {
    const bible = story([scene("scene:a", { exits: [{ to: "scene:b" as never }] }), scene("scene:b", { exits: [] })]);
    expect(rules(bible)).toContain("dead-end-scene");
  });

  it("rejects an ending that only a successful roll opens, and accepts it once failure moves the story on", () => {
    const gated = (onFailure: BibleInteraction["onFailure"]): AdventureBible => story(
      [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["door-open"] } }] }), scene("scene:b", { ending: true, exits: [] })],
      [interaction("pick-the-lock", "scene:a", { check: { skill: "thievery", dc: 15 }, onSuccess: [{ kind: "set", flag: "door-open" }], onFailure })],
    );
    expect(rules(gated([]))).toContain("ending-stranded");
    // The lock breaks anyway, at a cost: the way on is still there when the roll fails.
    expect(rules(gated([{ kind: "set", flag: "door-open" }]))).toEqual([]);
  });

  it("accepts an ending that a no-roll interaction opens", () => {
    const bible = story(
      [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["door-open"] } }] }), scene("scene:b", { ending: true, exits: [] })],
      [interaction("open-the-door", "scene:a", { onSuccess: [{ kind: "set", flag: "door-open" }] })],
    );
    expect(rules(bible)).toEqual([]);
  });

  it("warns about a single roll that decides something the story needs, unless there is another way", () => {
    const scenes = [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["door-open"] } }] }), scene("scene:b", { ending: true, exits: [] })];
    const lock = interaction("pick-the-lock", "scene:a", { check: { skill: "thievery", dc: 15 }, onSuccess: [{ kind: "set", flag: "door-open" }] });
    const names = (bible: AdventureBible): string[] => analyzeStoryContract(bible).map((finding) => finding.rule);
    expect(names(story(scenes, [lock]))).toContain("rolled-gate");
    expect(names(story(scenes, [lock, interaction("break-the-door", "scene:a", { onSuccess: [{ kind: "set", flag: "door-open" }] })]))).not.toContain("rolled-gate");
  });
});

describe("the adventure template", () => {
  it("is a valid adventure with no story findings, so it is a safe place to start", async () => {
    const { readFileSync } = await import("node:fs");
    const { validateAdventure } = await import("../../../src/application/campaign/adventures/adventure-validator.js");
    const { ruleset } = await import("../../domain/campaign/campaign-fixtures.js");
    const source = readFileSync(new URL("../../../docs/adventure-template.yaml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const report = validateAdventure(source, ruleset().content);
    expect({ errors: report.errors, warnings: report.warnings }).toEqual({ errors: [], warnings: [] });
  });
});

describe("what NPCs tell", () => {
  it("counts as a free way to a clue, so a clue gate an NPC answers is not a stranded ending", () => {
    const scenes = [scene("scene:a", { npcIds: ["npc:hag" as never], exits: [{ to: "scene:b" as never, requires: { clues: ["clue:truth"] } }] }), scene("scene:b", { ending: true, exits: [] })];
    const bare = story(scenes, [interaction("search", "scene:a", { check: { skill: "investigation", dc: 15 }, onSuccess: [{ kind: "reveal", clue: "clue:truth" }] })]);
    expect(rules(bare)).toContain("ending-stranded");
    const told: AdventureBible = { ...bare, npcs: [{ id: "npc:hag", name: "Hag", voice: "", publicDescription: "", secret: "", tells: [{ clue: "clue:truth" as never, topics: ["truth"] }] } as never] };
    expect(rules(told)).toEqual([]);
  });
});
