import { describe, expect, it } from "vitest";

import { AdventureDocumentError, checkEditionsMatch, parseAdventureDocument } from "../../../src/application/campaign/adventures/adventure-document.js";
import { plannerStory, resolveStoryEffects, type ResolveOptions } from "../../../src/application/campaign/dm/story-effects.js";
import type { PlannerProposal } from "../../../src/application/campaign/ports/dm-ports.js";
import { encounterSpec } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign } from "../../domain/campaign/campaign-fixtures.js";

// Hazards, saving throws, random tables, keepsakes, notices, arrival effects, ambushes and a fight's dread, as an adventure says them.

const hero = `
  - id: c-borin
    name: Borin
    class: fighter
    abilityScores: { str: 16, dex: 12, con: 15, int: 10, wis: 12, cha: 8 }
    proficiencyBonus: 2
    skills: { athletics: proficient }
    savingThrows: [str, con]
    level: 1
    maxHp: 12
    hitDie: 10
    speed: 30
    equipment: [item:longsword]
    features: []`;

const document = (interactions: string, extras = "", scenes = ""): string => `
id: mini
version: "1"
language: en
title: Mini
premise: A small place.
dmOverview: Notes.
startScene: scene:inn
scenes:
  - id: scene:inn
    title: Inn
    publicDescription: A warm inn.
    dmNotes: Notes.
    npcIds: []
  - id: scene:field
    title: Field
    publicDescription: A field.
    dmNotes: Notes.
    npcIds: []
${scenes}
npcs: []
clues:
  - { id: clue:tracks, sceneId: scene:field, publicText: Big tracks., dmNotes: Notes. }
${extras}
interactions:${interactions.trim() === "" ? " []" : `
${interactions}`}
heroes:${hero}
`;

const inField = { ...newCampaign(), sceneId: "scene:field" as const };

const attempt = (interactionId: string, ...heroes: readonly string[]): PlannerProposal => ({
  roundNumber: 1,
  actions: (heroes.length === 0 ? ["c-mira"] : heroes).map((characterId) => ({
    characterId,
    resolution: { kind: "check", test: { kind: "skill", skill: "perception" }, dcTier: "medium", rollModeReasons: [] },
    interactionId,
  })),
  effects: [],
});

function resolve(source: string, interactionId: string, state: CampaignState = inField, options: ResolveOptions = { wallet: "pool", random: () => 0 }, ...heroes: string[]): RoundPlanProposal {
  const { bible } = parseAdventureDocument(source);
  const resolved = resolveStoryEffects(attempt(interactionId, ...heroes), bible, state, options);
  if (resolved.kind !== "resolved") throw new Error(resolved.problems.join(" "));
  return resolved.proposal;
}

const foulWater = `
  - id: interaction:drink
    sceneId: scene:field
    label: Drink from the trough
    dmNotes: The water is foul.
    check: { ability: con, dc: 12, save: true }
    onSuccess:
      - { kind: set, flag: fine }
    onFailure:
      - { kind: hurt, count: 2, sides: 6, damageType: poison }
      - { kind: notice, text: The water burns going down. }
`;

describe("saving throws and harm", () => {
  it("rolls the authored saving throw, and hangs harm on each rolling hero's own failure", () => {
    const plan = resolve(document(foulWater), "interaction:drink", inField, { wallet: "pool", random: () => 0 }, "c-mira", "c-borin");
    expect(plan.actions[0]?.resolution).toMatchObject({ kind: "check", test: { kind: "save", ability: "con" }, dc: 12 });
    const hurt = plan.effects?.filter((planned) => planned.effect.kind === "hurt") ?? [];
    expect(hurt.map((planned) => [planned.effect.kind === "hurt" ? planned.effect.characterId : "", planned.when])).toEqual([
      ["c-mira", { kind: "checkOutcome", characterId: "c-mira", success: false }],
      ["c-borin", { kind: "checkOutcome", characterId: "c-borin", success: false }],
    ]);
    expect(plan.effects?.find((planned) => planned.effect.kind === "notice")).toMatchObject({ effect: { text: "The water burns going down." }, when: { kind: "anyCheck", success: false } });
  });

  it("can hurt the whole party at once", () => {
    const party = foulWater.replace("damageType: poison }", "damageType: poison, who: party }");
    const plan = resolve(document(party), "interaction:drink");
    const targets = plan.effects?.flatMap((planned) => (planned.effect.kind === "hurt" ? [planned.effect.characterId] : []));
    expect(targets).toEqual(Object.keys(newCampaign().characters));
  });

  it("asks for an ability when it is a saving throw", () => {
    const broken = foulWater.replace("ability: con, dc: 12, save: true", "skill: survival, dc: 12, save: true");
    expect(() => parseAdventureDocument(document(broken))).toThrow(/saving throw names an ability/);
  });
});

describe("a table on the page", () => {
  const table = `
  - id: interaction:rummage
    sceneId: scene:field
    label: Rummage through the cart
    dmNotes: A d4 table.
    onSuccess:
      - kind: random
        options:
          - { effects: [{ kind: reward, gold: 5 }] }
          - { weight: 3, effects: [{ kind: notice, text: Only straw. }] }
`;

  it("picks one outcome by chance and plans only that one", () => {
    const first = resolve(document(table), "interaction:rummage", inField, { wallet: "pool", random: () => 0 });
    expect(first.effects?.map((planned) => planned.effect.kind)).toContain("grantReward");
    expect(first.effects?.map((planned) => planned.effect.kind)).not.toContain("notice");
    const last = resolve(document(table), "interaction:rummage", inField, { wallet: "pool", random: () => 0.99 });
    expect(last.effects?.map((planned) => planned.effect.kind)).toContain("notice");
    expect(last.effects?.map((planned) => planned.effect.kind)).not.toContain("grantReward");
  });

  it("weights the options", () => {
    // Weights 1 and 3: the first quarter of the range is the reward.
    const at = (roll: number): string => resolve(document(table), "interaction:rummage", inField, { wallet: "pool", random: () => roll }).effects?.map((planned) => planned.effect.kind).join(",") ?? "";
    expect(at(0.2)).toContain("grantReward");
    expect(at(0.3)).toContain("notice");
  });

  it("needs at least two options, and checks what is inside them", () => {
    expect(() => parseAdventureDocument(document(table.replace(/ {10}- \{ weight: 3.*\n/, "")))).toThrow();
    const unknown = table.replace("kind: notice, text: Only straw.", "kind: reveal, clue: clue:missing");
    expect(() => parseAdventureDocument(document(unknown))).toThrow(/unknown clue:missing/);
  });
});

describe("keepsakes, notices and arrival", () => {
  const extras = `
    - id: interaction:take-token
      sceneId: scene:inn
      label: Take the token
      dmNotes: Offered freely.
      onSuccess:
        - { kind: keepsake, id: bent-token, name: Bent's token, description: A carved wooden token. }
        - { kind: goto, scene: scene:field }
`;
  const scenes = document(extras).replace(
    "    title: Field\n    publicDescription: A field.\n    dmNotes: Notes.\n    npcIds: []\n",
    "    title: Field\n    publicDescription: A field.\n    dmNotes: Notes.\n    npcIds: []\n    onEnter:\n      - { kind: notice, text: Crickets stop as you arrive. }\n      - { kind: set, flag: seen-field }\n",
  );
  const inn = { ...newCampaign(), sceneId: "scene:inn" as const };

  it("plans the keepsake with its words and adds the arrival effects after a move", () => {
    const plan = resolve(scenes, "interaction:take-token", inn);
    const kinds = plan.effects?.map((planned) => planned.effect.kind);
    expect(kinds).toEqual(["setFlag", "setFlag", "grantKeepsake", "transitionScene", "notice", "setFlag"]);
    expect(plan.effects?.find((planned) => planned.effect.kind === "grantKeepsake")?.effect).toEqual({ kind: "grantKeepsake", keepsake: { id: "bent-token", name: "Bent's token", description: "A carved wooden token." } });
  });

  it("adds them when the Planner itself moves the party", () => {
    const { bible } = parseAdventureDocument(scenes);
    const moved = resolveStoryEffects({ roundNumber: 1, actions: [], effects: [{ kind: "transitionScene", sceneId: "scene:field", when: { kind: "always" } }] }, bible, inn);
    if (moved.kind !== "resolved") throw new Error("expected a resolution");
    expect(moved.proposal.effects?.map((planned) => planned.effect.kind)).toEqual(["transitionScene", "notice", "setFlag"]);
  });

  it("does not accept a move or a fight inside an arrival", () => {
    expect(() => parseAdventureDocument(scenes.replace("{ kind: set, flag: seen-field }", "{ kind: goto, scene: scene:inn }"))).toThrow();
  });

  it("lets a flag set on arrival open an interaction", () => {
    const gate = "    - { id: interaction:x, sceneId: scene:inn, label: x, dmNotes: x, requires: { flags: [seen-field] } }\n";
    expect(() => parseAdventureDocument(scenes.replace("heroes:", `${gate}heroes:`))).not.toThrow();
    expect(() => parseAdventureDocument(scenes.replace("heroes:", `${gate}heroes:`).replace("{ kind: set, flag: seen-field }", "{ kind: set, flag: seen-elsewhere }"))).toThrow(/nothing sets/);
  });

  it("brings arrival effects along when a fight's victory moves the party", () => {
    const fight = `
encounters:
  - id: encounter:field
    sceneId: scene:inn
    publicDescription: Night falls.
    dmNotes: Notes.
    zones: [{ id: rows, name: Rows }]
    edges: []
    partyZoneId: rows
    monsters: [{ monsterId: monster:goblin, zoneId: rows }]
    onVictory:
      - { kind: goto, scene: scene:field }
`;
    const { bible } = parseAdventureDocument(scenes.replace("npcs: []", `npcs: []\n${fight}`));
    const spec = encounterSpec(bible.encounters[0]!, bible);
    expect(spec.onVictory?.map((effect) => effect.kind)).toEqual(["transitionScene", "notice", "setFlag"]);
  });

  it("compares two editions without the translated words", () => {
    const english = parseAdventureDocument(scenes);
    const chinese = parseAdventureDocument(
      scenes.replace("language: en", "language: zh-TW").replace("Crickets stop as you arrive.", "你一到，蟋蟀便安靜下來。").replace("A carved wooden token.", "一枚雕刻的木牌。").replace("Bent's token", "班特的木牌"),
    );
    expect(checkEditionsMatch([english, chinese])).toEqual([]);
    const different = parseAdventureDocument(scenes.replace("language: en", "language: zh-TW").replace("flag: seen-field", "flag: seen-fields").replace("requires: { flags: [seen-field] }", ""));
    expect(checkEditionsMatch([english, different])).not.toEqual([]);
  });
});

describe("whose gold pays", () => {
  const pay = `
  - id: interaction:bribe
    sceneId: scene:field
    label: Bribe the guard
    dmNotes: A bribe.
    pay: 10
    onSuccess:
      - { kind: set, flag: bribed }
`;

  it("checks the hero's own purse at a split table and the party purse at a pooled one", () => {
    const { bible } = parseAdventureDocument(document(pay));
    const rich = { ...inField, gold: 100, heroGold: { "c-mira": 3 } };
    expect(resolveStoryEffects(attempt("interaction:bribe"), bible, rich, { wallet: "hero" })).toMatchObject({ kind: "invalid" });
    expect(resolveStoryEffects(attempt("interaction:bribe"), bible, rich, { wallet: "pool" })).toMatchObject({ kind: "resolved" });
    // A split table where no hero has been paid yet: the guess that used to be made from the wallets is gone.
    expect(resolveStoryEffects(attempt("interaction:bribe"), bible, { ...inField, gold: 100 }, { wallet: "hero" })).toMatchObject({ kind: "invalid" });
  });
});

describe("a fight that starts in ambush or with dread", () => {
  const fight = (extra: string): string => `
encounters:
  - id: encounter:field
    sceneId: scene:field
    publicDescription: Night falls.
    dmNotes: Notes.
    zones: [{ id: rows, name: Rows }]
    edges: []
    partyZoneId: rows
    monsters: [{ monsterId: monster:goblin, zoneId: rows }]
${extra}
`;

  it("reaches the engine's encounter spec", () => {
    const { bible } = parseAdventureDocument(document("", fight("    ambush: { dc: 14 }\n    dread: { ability: wis, dc: 11 }\n    surprised: foes")));
    expect(encounterSpec(bible.encounters[0]!, bible)).toMatchObject({ ambush: { dc: 14 }, dread: { ability: "wis", dc: 11 }, surprised: "foes" });
  });

  it("refuses a dread with no ability", () => {
    expect(() => parseAdventureDocument(document("", fight("    dread: { dc: 11 }")))).toThrow(AdventureDocumentError);
  });

  it("stays out of the Planner's list of fights it can name until it is time", () => {
    const { bible } = parseAdventureDocument(document("", fight("    ambush: { dc: 14 }")));
    expect(plannerStory(bible, inField).encounters).toEqual([{ id: "encounter:field", sceneId: "scene:field" }]);
  });
});
