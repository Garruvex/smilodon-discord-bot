import { describe, expect, it } from "vitest";

import { directPlan, nextClue, openLead, plainLabel, stalledRounds, stallLevel } from "../../../src/application/campaign/dm/stall-director.js";
import type { PlannerProposal } from "../../../src/application/campaign/ports/dm-ports.js";
import type { AdventureBible, BibleInteraction } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";

const resolved = { kind: "roundResolved", roundNumber: 1 } as unknown as CampaignEvent;
const moved = { kind: "clueRevealed", roundNumber: 1, clueId: "clue:x", text: "x" } as CampaignEvent;
const tried = { kind: "flagSet", roundNumber: 1, flag: "tried:interaction:a", value: 1 } as unknown as CampaignEvent;

const interaction = (id: string, extra: Partial<BibleInteraction> = {}): BibleInteraction => ({
  id: `interaction:${id}` as BibleInteraction["id"], sceneId: "scene:a" as BibleInteraction["sceneId"], label: id, dmNotes: "",
  check: null, requires: {}, pay: 0, attempts: 1, onSuccess: [{ kind: "set", flag: id }], onFailure: [], tiers: [], ...extra,
});
const bible = (interactions: readonly BibleInteraction[]): AdventureBible => ({
  id: "t", version: "1", language: "en", title: "", premise: "", dmOverview: "", startScene: "scene:a", scenes: [], npcs: [], encounters: [], clocks: [],
  clues: [{ id: "clue:one", sceneId: "scene:a", publicText: "one", dmNotes: "" }, { id: "clue:two", sceneId: "scene:a", publicText: "two", dmNotes: "" }],
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

  it("steps up at the configured rounds", () => {
    expect([2, 3, 5, 6, 8, 9, 20].map((rounds) => stallLevel(rounds))).toEqual([0, 1, 1, 2, 2, 3, 3]);
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
    expect(forced.proposal.actions[0]).toMatchObject({ interactionId: "interaction:lock", resolution: { kind: "automatic" } });
    const taken = forced.bible.interactions?.find((candidate) => candidate.id === "interaction:lock");
    expect(taken).toMatchObject({ check: null, pay: 0 });
    expect(forced.bible.interactions?.find((candidate) => candidate.id === "interaction:chat")?.check).not.toBeNull();
    // With no fallback step authored, nothing is forced.
    const none = directPlan(round(), bible([ordinary]), state(), 3);
    expect(none.proposal.actions[0]).not.toHaveProperty("interactionId");
  });

  it("points the narrator at the first open step that would move the story, without the skill in brackets", () => {
    const lead = openLead(bible([interaction("decor", { onSuccess: [{ kind: "notice", text: "n" }] }), interaction("find-it", { label: "Find the door（察覺）" })]), state());
    expect(lead?.id).toBe("interaction:find-it");
    expect(plainLabel("Find the door（察覺）")).toBe("Find the door");
    expect(plainLabel("Pick the lock (Thievery)")).toBe("Pick the lock");
  });
});
