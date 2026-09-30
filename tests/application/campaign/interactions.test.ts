import { describe, expect, it } from "vitest";

import { AdventureDocumentError, parseAdventureDocument } from "../../../src/application/campaign/adventures/adventure-document.js";
import { availableInteractions, reachableScenes } from "../../../src/application/campaign/dm/interactions.js";
import { plannerStory, resolveStoryEffects } from "../../../src/application/campaign/dm/story-effects.js";
import type { PlannerProposal } from "../../../src/application/campaign/ports/dm-ports.js";
import { encounterSpec } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import { newCampaign } from "../../domain/campaign/campaign-fixtures.js";

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

const yaml = (interactions: string, extra = ""): string => `
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
    exits:
      - { to: scene:field }
      - { to: scene:cellar, requires: { flags: [cellar-open] } }
  - id: scene:field
    title: Field
    publicDescription: A field.
    dmNotes: Notes.
    npcIds: []
  - id: scene:cellar
    title: Cellar
    publicDescription: A cellar.
    dmNotes: Notes.
    npcIds: []
npcs: []
clues:
  - { id: clue:tracks, sceneId: scene:field, publicText: Big tracks., dmNotes: Notes. }
${extra}
interactions:
${interactions}
heroes:${hero}
`;

const search = `
  - id: interaction:search-field
    sceneId: scene:field
    label: Search the field for tracks
    dmNotes: When the party looks over the field.
    check: { skill: survival, dc: 10 }
    onSuccess:
      - { kind: reveal, clue: clue:tracks }
      - { kind: set, flag: cellar-open }
    onFailure:
      - { kind: set, flag: spooked }
    tiers:
      - dc: 15
        effects:
          - { kind: reward, gold: 25 }
  - id: interaction:ask-innkeeper
    sceneId: scene:inn
    label: Ask the innkeeper about the field
    dmNotes: A friendly chat.
    pay: 5
    onSuccess:
      - { kind: goto, scene: scene:field }
`;

const inField = { ...newCampaign(), sceneId: "scene:field" as const };

function proposal(interactionId: string | null): PlannerProposal {
  return {
    roundNumber: 1,
    actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "perception" }, dcTier: "medium", rollModeReasons: [] }, interactionId }],
    effects: [],
  };
}

describe("parsing interactions", () => {
  it("reads checks, tiers, requirements and exits", () => {
    const { bible } = parseAdventureDocument(yaml(search));
    expect(bible.interactions).toHaveLength(2);
    expect(bible.interactions?.[0]).toMatchObject({ id: "interaction:search-field", check: { skill: "survival", dc: 10 }, attempts: 1, pay: 0 });
    expect(bible.interactions?.[0]?.tiers).toEqual([{ dc: 15, effects: [{ kind: "reward", gold: 25 }] }]);
    expect(bible.scenes[0]?.exits).toEqual([{ to: "scene:field" }, { to: "scene:cellar", requires: { flags: ["cellar-open"] } }]);
  });

  it("names every mistake at once: unknown references, unset flags, bad tiers", () => {
    const broken = `
  - id: interaction:a
    sceneId: scene:nowhere
    label: x
    dmNotes: x
    check: { skill: survival, dc: 10 }
    requires: { flags: [never-set], clues: [clue:missing] }
    onSuccess:
      - { kind: goto, scene: scene:void }
    tiers:
      - { dc: 9, effects: [{ kind: reveal, clue: clue:tracks }] }
  - id: interaction:b
    sceneId: scene:field
    label: x
    dmNotes: x
    check: { skill: nonsense, ability: str, dc: 10 }
`;
    try {
      parseAdventureDocument(yaml(broken));
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AdventureDocumentError);
      const problems = (error as AdventureDocumentError).problems.join("\n");
      expect(problems).toContain("unknown scene:nowhere");
      expect(problems).toContain('requires flag "never-set", which nothing sets');
      expect(problems).toContain("requires unknown clue:missing");
      expect(problems).toContain("goes to unknown scene:void");
      expect(problems).toContain("tiers must rise above");
      expect(problems).toContain("either a skill or an ability");
    }
  });
});

describe("what the party can do now", () => {
  const { bible } = parseAdventureDocument(yaml(search));

  it("lists the interactions of the current scene whose requirements hold", () => {
    expect(availableInteractions(bible, inField).map((interaction) => interaction.id)).toEqual(["interaction:search-field"]);
    expect(plannerStory(bible, inField).interactions).toEqual([{ id: "interaction:search-field", sceneId: "scene:field", label: "Search the field for tracks" }]);
  });

  it("closes an interaction after it succeeds, or after its tries are used", () => {
    expect(availableInteractions(bible, { ...inField, flags: { "done:interaction:search-field": 1 } })).toEqual([]);
    expect(availableInteractions(bible, { ...inField, flags: { "tried:interaction:search-field": 1 } })).toEqual([]);
  });

  it("limits travel to the scene's exits, and opens one when its flag is set", () => {
    const atInn = { ...newCampaign(), sceneId: "scene:inn" as const };
    expect(reachableScenes(bible, atInn)).toEqual(["scene:field"]);
    expect(reachableScenes(bible, { ...atInn, flags: { "cellar-open": 1 } })).toEqual(["scene:field", "scene:cellar"]);
    const cellar = resolveStoryEffects({ roundNumber: 1, actions: [], effects: [{ kind: "transitionScene", sceneId: "scene:cellar", when: { kind: "always" } }] }, bible, atInn);
    expect(cellar).toMatchObject({ kind: "invalid" });
  });
});

describe("choosing an interaction", () => {
  const { bible } = parseAdventureDocument(yaml(search));

  it("replaces the model's check with the authored one and hangs the results on it", () => {
    const resolved = resolveStoryEffects(proposal("interaction:search-field"), bible, inField);
    if (resolved.kind !== "resolved") throw new Error(resolved.problems.join(" "));
    expect(resolved.proposal.actions[0]?.resolution).toEqual({ kind: "check", test: { kind: "skill", skill: "survival" }, dcTier: "easy", dc: 10, rollModeReasons: [] });
    const summary = resolved.proposal.effects?.map((planned) => `${planned.effect.kind}:${planned.when.kind}`);
    expect(summary).toEqual([
      "setFlag:always",
      "setFlag:anyCheck",
      "revealClue:anyCheck",
      "setFlag:anyCheck",
      "setFlag:anyCheck",
      "grantReward:anyCheck",
    ]);
    const tier = resolved.proposal.effects?.find((planned) => planned.effect.kind === "grantReward");
    expect(tier).toMatchObject({ when: { kind: "anyCheck", characterIds: ["c-mira"], success: true, atLeast: 15 }, effect: { rewardId: "interaction:search-field:t0:0", gold: 25 } });
  });

  it("gives several heroes' attempts one set of results", () => {
    const two: PlannerProposal = {
      roundNumber: 1,
      actions: [
        { characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "survival" }, dcTier: "easy", rollModeReasons: [] }, interactionId: "interaction:search-field" },
        { characterId: "c-borin", resolution: { kind: "check", test: { kind: "skill", skill: "survival" }, dcTier: "easy", rollModeReasons: [] }, interactionId: "interaction:search-field" },
      ],
      effects: [],
    };
    const resolved = resolveStoryEffects(two, bible, inField);
    if (resolved.kind !== "resolved") throw new Error(resolved.problems.join(" "));
    expect(resolved.proposal.effects?.filter((planned) => planned.effect.kind === "revealClue")).toHaveLength(1);
    expect(resolved.proposal.effects?.find((planned) => planned.effect.kind === "revealClue")?.when).toMatchObject({ characterIds: ["c-mira", "c-borin"] });
  });

  it("refuses an interaction that is not available here, and a payment nobody can afford", () => {
    expect(resolveStoryEffects(proposal("interaction:ask-innkeeper"), bible, inField)).toMatchObject({ kind: "invalid" });
    const atInn = { ...newCampaign(), sceneId: "scene:inn" as const, gold: 2 };
    const broke = resolveStoryEffects(proposal("interaction:ask-innkeeper"), bible, atInn);
    expect(broke).toMatchObject({ kind: "invalid" });
    const paid = resolveStoryEffects(proposal("interaction:ask-innkeeper"), bible, { ...newCampaign(), sceneId: "scene:inn" as const, gold: 9 });
    if (paid.kind !== "resolved") throw new Error(paid.problems.join(" "));
    expect(paid.proposal.actions[0]?.resolution).toEqual({ kind: "automatic", reason: "Ask the innkeeper about the field" });
    expect(paid.proposal.effects?.map((planned) => planned.effect.kind)).toEqual(["spendGold", "setFlag", "setFlag", "transitionScene"]);
  });

  it("keeps one scene change when an interaction moves the party and the model proposes the same move", () => {
    const duplicate: PlannerProposal = { ...proposal("interaction:ask-innkeeper"), effects: [{ kind: "transitionScene", sceneId: "scene:field", when: { kind: "always" } }] };
    const resolved = resolveStoryEffects(duplicate, bible, { ...newCampaign(), sceneId: "scene:inn" as const, gold: 9 });
    if (resolved.kind !== "resolved") throw new Error(resolved.problems.join(" "));
    expect(resolved.proposal.effects?.filter((planned) => planned.effect.kind === "transitionScene")).toHaveLength(1);
  });

  it("leaves an action without an interaction exactly as the Planner planned it", () => {
    const resolved = resolveStoryEffects(proposal(null), bible, inField);
    if (resolved.kind !== "resolved") throw new Error(resolved.problems.join(" "));
    expect(resolved.proposal.actions[0]?.resolution).toMatchObject({ test: { skill: "perception" }, dcTier: "medium" });
    expect(resolved.proposal.effects).toEqual([]);
  });
});

describe("a fight's authored beats", () => {
  const fight = `
encounters:
  - id: encounter:field
    sceneId: scene:field
    publicDescription: Night falls.
    dmNotes: Notes.
    zones: [{ id: rows, name: Rows }, { id: edge, name: Edge }]
    edges: [{ from: edge, to: rows, feet: 30 }]
    partyZoneId: edge
    gold: 100
    monsters:
      - { monsterId: monster:goblin, zoneId: rows }
    triggers:
      - when: { kind: foesDown, count: 1 }
        effects:
          - { kind: announce, text: A hag steps out. }
          - { kind: add, monsters: [{ monsterId: monster:green-hag, zoneId: rows }] }
          - { kind: set, flag: hag-here }
      - when: { kind: round, round: 4 }
        effects:
          - { kind: end }
    onVictory:
      - { kind: reveal, clue: clue:tracks }
      - { kind: reward, gold: 50 }
      - { kind: goto, scene: scene:cellar }
`;

  it("becomes an encounter spec the engine plays, with clue text and reward ids filled in", () => {
    const { bible } = parseAdventureDocument(yaml(search, fight));
    const spec = encounterSpec(bible.encounters[0]!, bible);
    expect(spec.triggers).toEqual([
      {
        when: { kind: "foesDown", count: 1 },
        effects: [
          { kind: "announce", text: "A hag steps out." },
          { kind: "addMonsters", monsters: [{ monsterId: "monster:green-hag", zoneId: "rows", npcId: null, fleeBelowHpFraction: null }] },
          { kind: "setFlag", flag: "hag-here", value: 1 },
        ],
      },
      { when: { kind: "round", round: 4 }, effects: [{ kind: "endFight" }] },
    ]);
    expect(spec.onVictory).toEqual([
      { kind: "revealClue", clueId: "clue:tracks", text: "Big tracks." },
      { kind: "grantReward", rewardId: "encounter:field:victory:1", gold: 50, items: [] },
      { kind: "transitionScene", sceneId: "scene:cellar" },
    ]);
  });

  it("counts a flag a fight sets as set, and names a foe placed in a zone the fight lacks", () => {
    const gated = search.replace("check: { skill: survival, dc: 10 }", "requires: { flags: [hag-here] }\n    check: { skill: survival, dc: 10 }");
    expect(() => parseAdventureDocument(yaml(gated, fight))).not.toThrow();
    const lost = fight.replace("monsterId: monster:green-hag, zoneId: rows", "monsterId: monster:green-hag, zoneId: moat");
    expect(() => parseAdventureDocument(yaml(search, lost))).toThrow(/unknown zone moat/);
  });
});
