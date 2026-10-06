import { describe, expect, it } from "vitest";

import { searchStoryStates } from "../../../src/application/campaign/adventures/story-states.js";
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

describe("every state the story can reach", () => {
  const findings = (bible: AdventureBible) => analyzeStoryContract(bible).filter((finding) => finding.rule === "ending-stranded");

  it("finds an optional branch that traps the table for good, even though the ending is reachable another way", () => {
    // From the square the party may go home (the ending) or down the well; once down, the rope is gone and nothing leads out.
    const bible = story([
      scene("scene:square", { exits: [{ to: "scene:home" as never }, { to: "scene:well" as never }] }),
      scene("scene:well", { exits: [{ to: "scene:square" as never, requires: { flags: ["rope"] } }] }),
      scene("scene:home", { ending: true, exits: [] }),
    ], [interaction("climb", "scene:well", { check: { skill: "athletics", dc: 12 }, onSuccess: [{ kind: "set", flag: "rope" }] })]);
    const [finding] = findings(bible);
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("stranded in scene:well");
    expect(finding?.message).toContain("go to scene:well");
  });

  it("finds an exit a flag shuts (notFlags) once the story has set it", () => {
    const bible = story([
      scene("scene:gate", { exits: [{ to: "scene:end" as never, requires: { notFlags: ["alarm"] } }] }),
      scene("scene:end", { ending: true, exits: [] }),
    ], [interaction("ring-the-bell", "scene:gate", { onSuccess: [{ kind: "set", flag: "alarm" }] })]);
    expect(findings(bible)[0]?.message).toContain("ring-the-bell");
  });

  it("reads a flag set to zero as not set", () => {
    const bible = story([
      scene("scene:gate", { exits: [{ to: "scene:end" as never, requires: { flags: ["key"] } }] }),
      scene("scene:end", { ending: true, exits: [] }),
    ], [interaction("take-the-key", "scene:gate", { onSuccess: [{ kind: "set", flag: "key", value: 0 }] })]);
    expect(findings(bible)).toHaveLength(1);
    const fixed = story(bible.scenes, [interaction("take-the-key", "scene:gate", { onSuccess: [{ kind: "set", flag: "key" }] })]);
    expect(findings(fixed)).toEqual([]);
  });

  it("lets the table choose: a rolled way and a sure way to the same place is safe, and a lost fight with an onDefeat is too", () => {
    const scenes = [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["open"] } }] }), scene("scene:b", { ending: true, exits: [] })];
    const rolled = interaction("force", "scene:a", { check: { skill: "athletics", dc: 15 }, onSuccess: [{ kind: "set", flag: "open" }] });
    const sure = interaction("ask-the-keeper", "scene:a", { onSuccess: [{ kind: "set", flag: "open" }] });
    expect(findings(story(scenes, [rolled, sure]))).toEqual([]);
    const fightFor = (onDefeat: readonly object[]): AdventureBible => ({
      ...story(scenes, [interaction("challenge", "scene:a", { onSuccess: [{ kind: "encounter", encounter: "encounter:guard" as never }] })]),
      encounters: [{ id: "encounter:guard", sceneId: "scene:a", publicDescription: "", dmNotes: "", zones: [], edges: [], partyZoneId: "", monsters: [], loot: [], gold: 0, onVictory: [{ kind: "set", flag: "open" }], onDefeat }] as never,
    });
    // With nothing after a lost fight, even the start is unsafe: the only way on can be lost.
    expect(findings(fightFor([]))[0]?.message).toContain("stranded in scene:a");
    expect(findings(fightFor([{ kind: "set", flag: "open" }]))).toEqual([]);
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

describe("scheduled fights", () => {
  it("count as a free way on: a fight that breaks out by itself and sets the flag a gate needs", () => {
    const scenes = [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["won"] } }] }), scene("scene:b", { ending: true, exits: [] })];
    const base = story(scenes);
    const fightOnly = (schedule?: object): AdventureBible => ({ ...base, interactions: [interaction("start", "scene:a", { check: { skill: "stealth", dc: 12 }, onSuccess: [{ kind: "encounter", encounter: "encounter:ambush" as never }] })], encounters: [{ id: "encounter:ambush", sceneId: "scene:a", publicDescription: "", dmNotes: "", zones: [], edges: [], partyZoneId: "", monsters: [], loot: [], gold: 0, onVictory: [{ kind: "set", flag: "won" }], onDefeat: [{ kind: "set", flag: "won" }], ...(schedule === undefined ? {} : { schedule }) }] as never });
    expect(rules(fightOnly())).toContain("ending-stranded");
    expect(rules(fightOnly({ afterRounds: 1 }))).toEqual([]);
  });
});

describe("a lost fight", () => {
  it("must still leave the story a way on", () => {
    const scenes = [scene("scene:a", { exits: [{ to: "scene:b" as never, requires: { flags: ["won"] } }] }), scene("scene:b", { ending: true, exits: [] })];
    const fightWith = (onDefeat: readonly object[]): AdventureBible => ({
      ...story(scenes, [interaction("fight", "scene:a", { onSuccess: [{ kind: "encounter", encounter: "encounter:boss" as never }] })]),
      encounters: [{ id: "encounter:boss", sceneId: "scene:a", publicDescription: "", dmNotes: "", zones: [], edges: [], partyZoneId: "", monsters: [], loot: [], gold: 0, onVictory: [{ kind: "set", flag: "won" }], onDefeat }] as never,
    });
    expect(rules(fightWith([]))).toContain("ending-stranded");
    // Beaten, the party is carried off; the way on is still there, at a cost.
    expect(rules(fightWith([{ kind: "set", flag: "won" }]))).toEqual([]);
  });
});

describe("endings", () => {
  it("lets the good ending need success as long as a floor ending is always open", () => {
    const scenes = [
      scene("scene:a", { exits: [{ to: "scene:good" as never, requires: { flags: ["door-open"] } }, { to: "scene:floor" as never }] }),
      scene("scene:good", { ending: true, exits: [] }),
      scene("scene:floor", { ending: true, exits: [] }),
    ];
    const rolled = interaction("pick-the-lock", "scene:a", { check: { skill: "thievery", dc: 15 }, onSuccess: [{ kind: "set", flag: "door-open" }] });
    expect(rules(story(scenes, [rolled]))).toEqual([]);
    // Without the floor ending, a bad roll closes the story.
    expect(rules(story(scenes.slice(0, 2).map((entry, index) => (index === 0 ? scene("scene:a", { exits: [{ to: "scene:good" as never, requires: { flags: ["door-open"] } }] }) : entry)), [rolled]))).toContain("ending-stranded");
  });
});

describe("keeping the search small without changing what it finds", () => {
  const states = (bible: AdventureBible): number => {
    const result = searchStoryStates(bible, bible.scenes.filter((candidate) => candidate.ending === true).map((candidate) => candidate.id), 100_000, 10_000);
    return result.kind === "complete" ? result.states : -1;
  };
  const gate = (n: number): readonly BibleInteraction[] => Array.from({ length: n }, (_, i) => interaction(`pull-${i}`, "scene:a", { check: { skill: "athletics", dc: 10 }, onSuccess: [{ kind: "set", flag: `lever-${i}` }], onFailure: [{ kind: "set", flag: `lever-${i}` }] }));

  it("merges every way of ending in the same scene into one state", () => {
    const readers = Array.from({ length: 6 }, (_, i) => scene(`scene:r${i}`, { exits: [{ to: "scene:end" as never }] }));
    const bible = story([scene("scene:a", { exits: [{ to: "scene:end" as never }] }), scene("scene:end", { ending: true, exits: [] }), ...readers], [...gate(6)]);
    expect(states(bible)).toBeLessThanOrEqual(3);
  });

  it("does not treat going where a plain exit already goes as a choice of its own", () => {
    const bible = story([scene("scene:a", { exits: [{ to: "scene:b" as never }] }), scene("scene:b", { exits: [{ to: "scene:a" as never }, { to: "scene:end" as never }] }), scene("scene:end", { ending: true, exits: [] })], [
      interaction("take-the-road", "scene:a", { onSuccess: [{ kind: "goto", scene: "scene:b" as never }] }),
    ]);
    expect(states(bible)).toBe(3);
  });

  it("still finds a trap after the reductions", () => {
    const bible = story([
      scene("scene:square", { exits: [{ to: "scene:home" as never }, { to: "scene:well" as never }] }),
      scene("scene:well", { exits: [{ to: "scene:square" as never, requires: { flags: ["rope"] } }] }),
      scene("scene:home", { ending: true, exits: [] }),
    ], [interaction("climb", "scene:well", { check: { skill: "athletics", dc: 12 }, onSuccess: [{ kind: "set", flag: "rope" }] })]);
    expect(analyzeStoryContract(bible).some((finding) => finding.rule === "ending-stranded" && finding.severity === "error")).toBe(true);
  });
});
