import { describe, expect, it } from "vitest";

import { parseAdventureDocument } from "../../../src/application/campaign/adventures/adventure-document.js";
import { buildPlaces } from "../../../src/application/campaign/views/story-views.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign } from "../../domain/campaign/campaign-fixtures.js";

const { bible } = parseAdventureDocument(`
id: mini
version: "1"
language: en
title: Mini
premise: A small place.
dmOverview: Notes.
startScene: scene:inn
scenes:
  - { id: "scene:inn", title: Inn, publicDescription: A warm inn., dmNotes: Notes., npcIds: [] }
  - { id: "scene:field", title: Field, publicDescription: A field., dmNotes: Notes., npcIds: [] }
npcs: []
clues:
  - { id: "clue:tracks", sceneId: "scene:field", publicText: Big tracks., dmNotes: Notes. }
  - { id: "clue:ledger", sceneId: "scene:inn", publicText: A torn ledger., dmNotes: Notes. }
heroes:
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
    features: []
`);

const atInn: CampaignState = { ...newCampaign(), sceneId: "scene:inn" };
const opened = (roundNumber: number): CampaignEvent => ({ kind: "roundOpened", roundNumber, participants: [], closesAt: null });
const told = (roundNumber: number, text: string): CampaignEvent => ({ kind: "narrationRecorded", roundNumber, text });
const moved = (roundNumber: number, sceneId: "scene:inn" | "scene:field", reason?: "agreed" | "organizer" | "story"): CampaignEvent => ({
  kind: "sceneTransitioned",
  roundNumber,
  sceneId,
  ...(reason === undefined ? {} : { reason }),
});

// Rounds 1-2 at the inn, 3-4 in the field (finding tracks), 5 back at the inn.
const events: readonly CampaignEvent[] = [
  opened(1),
  told(1, "The innkeeper nods. The fire crackles low."),
  opened(2),
  told(2, "Rain taps the shutters."),
  moved(3, "scene:field", "agreed"),
  opened(3),
  { kind: "clueRevealed", roundNumber: 3, clueId: "clue:tracks", text: "Big tracks." },
  told(3, "Big tracks cross the mud, heading north."),
  opened(4),
  told(4, "Wind tugs at the grass."),
  moved(5, "scene:inn", "organizer"),
  opened(5),
];

describe("where the party has been", () => {
  it("keeps one entry per stay, so a scene visited twice shows twice", () => {
    const state = replay(atInn, events);
    expect(state.visits?.map((visit) => [visit.id, visit.sceneId, visit.arrivedRound, visit.leftRound ?? null, visit.arrivedBy ?? null])).toEqual([
      ["visit-1", "scene:inn", 1, 3, null],
      ["visit-2", "scene:field", 3, 5, "agreed"],
      ["visit-3", "scene:inn", 5, null, "organizer"],
    ]);
    expect(state.visits?.[1]?.cameFrom).toBe("scene:inn");
    expect(state.sceneId).toBe("scene:inn");
  });

  it("starts the record at the first move in a game that began without one", () => {
    expect(atInn.visits).toBeUndefined();
    expect(buildPlaces(atInn, [], bible)).toEqual([]);
  });

  it("calls a move the story makes by that name unless told otherwise", () => {
    const state = replay(atInn, [moved(2, "scene:field")]);
    expect(state.visits?.[1]?.arrivedBy).toBe("story");
  });

  it("tells each stay with the opening of its last telling, what was found, and what was left", () => {
    const state = replay(atInn, events);
    const places = buildPlaces(state, events, bible);
    expect(places.map((place) => [place.sceneTitle, place.fromRound, place.throughRound, place.told])).toEqual([
      ["Inn", 1, 2, "Rain taps the shutters."],
      ["Field", 3, 4, "Wind tugs at the grass."],
      ["Inn", 5, null, null],
    ]);
    expect(places[1]).toMatchObject({ cluesFound: 1, fights: 0, cluesLeft: 0 });
    // The first stay at the inn is over and the ledger was never found; the present one is not counted as left behind.
    expect(places[0]).toMatchObject({ cluesLeft: 1 });
    expect(places[2]).toMatchObject({ cluesLeft: 0 });
  });

  it("cuts a long telling short, at its first sentence when it has one", () => {
    const long = `${"A".repeat(300)}.`;
    const state = replay(atInn, [moved(2, "scene:field")]);
    const places = buildPlaces(state, [opened(1), told(1, long), opened(2)], bible);
    expect(places[0]?.told?.length).toBeLessThanOrEqual(140);
    expect(places[0]?.told?.endsWith("…")).toBe(true);
  });
});
