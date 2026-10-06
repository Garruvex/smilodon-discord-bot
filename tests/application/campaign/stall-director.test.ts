import { describe, expect, it } from "vitest";

import { directPlan, nextClue, openLead, plainLabel, roundsInScene, scheduledEffects, scheduledWait, stalledRounds, stallLevel } from "../../../src/application/campaign/dm/stall-director.js";
import type { PlannerProposal } from "../../../src/application/campaign/ports/dm-ports.js";
import type { AdventureBible, BibleInteraction } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";

const resolved = { kind: "roundResolved", roundNumber: 1 } as unknown as CampaignEvent;
const passed = { kind: "roundResolved", roundNumber: 1, quiet: true } as unknown as CampaignEvent;
const moved = { kind: "clueRevealed", roundNumber: 1, clueId: "clue:x", text: "x" } as CampaignEvent;
const tried = { kind: "flagSet", roundNumber: 1, flag: "tried:interaction:a", value: 1 } as unknown as CampaignEvent;

const interaction = (id: string, extra: Partial<BibleInteraction> = {}): BibleInteraction => ({
  id: `interaction:${id}` as BibleInteraction["id"], sceneId: "scene:a" as BibleInteraction["sceneId"], label: id, dmNotes: "",
  check: null, requires: {}, pay: 0, attempts: 1, onSuccess: [{ kind: "set", flag: id }], onFailure: [], tiers: [], ...extra,
});
const bible = (interactions: readonly BibleInteraction[]): AdventureBible => ({
  id: "t", version: "1", language: "en", title: "", premise: "", dmOverview: "", startScene: "scene:a", scenes: [], npcs: [], encounters: [], clocks: [],
  clues: [{ id: "clue:one", sceneId: "scene:a", publicText: "one", dmNotes: "", free: true }, { id: "clue:two", sceneId: "scene:a", publicText: "two", dmNotes: "", free: true }, { id: "clue:answer", sceneId: "scene:a", publicText: "the answer", dmNotes: "" }],
  interactions,
} as unknown as AdventureBible);
const state = (clues: readonly string[] = []): CampaignState => ({ sceneId: "scene:a", clues: clues.map((id) => ({ id, text: "" })), flags: {} }) as unknown as CampaignState;
const round = (actions = 1): PlannerProposal => ({ roundNumber: 5, actions: Array.from({ length: actions }, (_, index) => ({ characterId: `c-${index}`, resolution: { kind: "automatic", reason: "r" } as const })), effects: [] });

describe("counting a stalled table", () => {
  it("counts the rounds since the story last moved, and a try is not movement", () => {
    expect(stalledRounds([resolved, resolved])).toBe(2);
    expect(stalledRounds([moved, resolved, resolved, resolved])).toBe(3);
    expect(stalledRounds([resolved, moved, resolved])).toBe(1);
    expect(stalledRounds([moved, resolved, tried, resolved])).toBe(2);
  });

  it("does not count a round everyone passed", () => {
    expect(stalledRounds([resolved, passed, passed, passed, resolved])).toBe(2);
    expect(roundsInScene([resolved, passed, passed])).toBe(1);
  });

  it("steps up at the configured rounds", () => {
    expect([2, 5, 6, 7, 8, 9, 10, 20].map((rounds) => stallLevel(rounds))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
});

describe("what the director does", () => {
  it("does nothing below the free-clue step", () => {
    const bare = round();
    expect(directPlan(bare, bible([]), state(), 1)).toEqual({ proposal: bare, bible: bible([]) });
  });

  it("gives the scene's next clue, in the order written, when the table has stalled", () => {
    const first = directPlan(round(), bible([]), state(), 2).proposal.effects;
    expect(first).toEqual([{ kind: "revealClue", clueId: "clue:one", when: { kind: "always" } }]);
    expect(nextClue(bible([]), state(["clue:one"]))?.id).toBe("clue:two");
    expect(directPlan(round(), bible([]), state(["clue:one", "clue:two"]), 2).proposal.effects).toEqual([]);
  });

  it("takes the adventure's fallback step with no roll and no fee, and never any other step", () => {
    const rolled = interaction("lock", { check: { skill: "thievery", dc: 20 }, pay: 50, fallback: true });
    const ordinary = interaction("chat", { check: { skill: "persuasion", dc: 10 } });
    const forced = directPlan(round(), bible([ordinary, rolled]), state(), 3);
    // It happens beside the players' own actions, which are left exactly as they chose.
    expect(forced.proposal.worldSteps).toEqual(["interaction:lock"]);
    expect(forced.proposal.actions).toEqual(round().actions);
    // With no fallback step authored, nothing is forced.
    const none = directPlan(round(), bible([ordinary]), state(), 3);
    expect(none.proposal.worldSteps).toBeUndefined();
  });

  it("points the narrator at the first open step that would move the story, without the skill in brackets", () => {
    const lead = openLead(bible([interaction("decor", { onSuccess: [{ kind: "notice", text: "n" }] }), interaction("find-it", { label: "Find the door（察覺）" })]), state());
    expect(lead?.id).toBe("interaction:find-it");
    expect(plainLabel("Find the door（察覺）")).toBe("Find the door");
    expect(plainLabel("Pick the lock (Thievery)")).toBe("Pick the lock");
  });
});

describe("fights the adventure scheduled", () => {
  const withFight = (schedule: NonNullable<AdventureBible["encounters"][number]["schedule"]>): AdventureBible =>
    ({ ...bible([]), encounters: [{ id: "encounter:midnight", sceneId: "scene:a", schedule }] } as unknown as AdventureBible);
  const at = (extra: Record<string, unknown> = {}): CampaignState => ({ ...state(), encounterHistory: [], pendingEncounter: null, encounter: null, ...extra }) as unknown as CampaignState;
  const sceneEvents = (rounds: number): CampaignEvent[] => [{ kind: "sceneTransitioned", roundNumber: 1, sceneId: "scene:a" } as unknown as CampaignEvent, ...Array.from({ length: rounds }, () => resolved)];

  it("starts a fight once the party has waited long enough, the time is right and the requirement holds", () => {
    const bible2 = withFight({ time: "night" as never, afterRounds: 2, requires: { clues: ["clue:midnight" as never] } });
    const night = { world: { time: "night", day: 1 } };
    expect(scheduledEffects(bible2, at({ ...night, clues: [{ id: "clue:midnight", text: "" }] }), sceneEvents(2))).toEqual([{ kind: "startEncounter", encounterId: "encounter:midnight", when: { kind: "always" } }]);
    expect(scheduledEffects(bible2, at({ ...night, clues: [{ id: "clue:midnight", text: "" }] }), sceneEvents(1))).toEqual([]);
    expect(scheduledEffects(bible2, at({ world: { time: "dusk", day: 1 }, clues: [{ id: "clue:midnight", text: "" }] }), sceneEvents(5))).toEqual([]);
    expect(scheduledEffects(bible2, at(night), sceneEvents(5))).toEqual([]);
  });

  it("brings the time a fight is set for to a table that waits for it, once everything else is in place", () => {
    const bible2 = withFight({ time: "night" as never, afterRounds: 1, requires: { clues: ["clue:midnight" as never] } });
    const knowing = { clues: [{ id: "clue:midnight", text: "" }] };
    // Dusk to night is one phase; it waits for at least two rounds in the scene.
    expect(scheduledWait(bible2, at({ world: { time: "dusk", day: 1 }, ...knowing }), sceneEvents(2))).toBe(1);
    expect(scheduledWait(bible2, at({ world: { time: "dusk", day: 1 }, ...knowing }), sceneEvents(1))).toBe(0);
    expect(scheduledWait(bible2, at({ world: { time: "morning", day: 1 }, ...knowing }), sceneEvents(3))).toBe(4);
    // Not without the clue, not when it is already night (then the fight itself is due), and never for an adventure with no clock.
    expect(scheduledWait(bible2, at({ world: { time: "dusk", day: 1 } }), sceneEvents(3))).toBe(0);
    expect(scheduledWait(bible2, at({ world: { time: "night", day: 1 }, ...knowing }), sceneEvents(3))).toBe(0);
    expect(scheduledWait(bible2, at(knowing), sceneEvents(3))).toBe(0);
  });

  it("starts a fight with no conditions as soon as a round is planned in its scene, and never twice or during another fight", () => {
    const plain = withFight({});
    expect(scheduledEffects(plain, at(), [])).toHaveLength(1);
    expect(scheduledEffects(plain, at({ encounterHistory: ["encounter:midnight"] }), [])).toEqual([]);
    expect(scheduledEffects(plain, at({ pendingEncounter: { id: "encounter:other" } }), [])).toEqual([]);
    expect(roundsInScene([resolved, { kind: "sceneTransitioned", roundNumber: 2, sceneId: "scene:b" } as unknown as CampaignEvent, resolved])).toBe(1);
  });
});
