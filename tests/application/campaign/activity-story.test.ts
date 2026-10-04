import { describe, expect, it } from "vitest";

import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../src/domain/campaign/rules/content-registry.js";
import { buildActivityStory, storyLength } from "../../../src/application/campaign/views/activity-story.js";
import { newCampaign } from "../../domain/campaign/campaign-fixtures.js";

// The story the Activity shows is the public log: tellings, what heroes did and said, clues, place changes. Nothing private reaches it.

const bible = { scenes: [{ id: "scene:chapel", title: "The Drowned Chapel" }] } as unknown as AdventureBible;
const glossary = { names: {} } as unknown as Glossary;
const story = (events: readonly CampaignEvent[]) => buildActivityStory(newCampaign(), events, bible, glossary);

describe("the Activity story", () => {
  it("lists tellings, actions, speech and clues in the order they happened", () => {
    const entries = story([
      { kind: "openingRecorded", text: "Moonlight falls on the chapel." },
      { kind: "actionSubmitted", roundNumber: 1, characterId: "c-mira", text: "Raise the lantern.", revision: 1 },
      { kind: "heroSpoke", roundNumber: 1, characterId: "c-borin", text: "Stay close." },
      { kind: "narrationRecorded", roundNumber: 1, text: "The runes glow." },
      { kind: "clueRevealed", roundNumber: 1, clueId: "clue:runes", text: "The runes are a ward." },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["narration", "action", "speech", "narration", "clue"]);
    expect(entries[1]).toMatchObject({ kind: "action", who: "Mira", text: "Raise the lantern." });
    expect(entries[2]).toMatchObject({ kind: "speech", who: "Borin", text: "Stay close." });
  });

  it("keeps a hero's action in its place and shows the newest wording after an edit", () => {
    const entries = story([
      { kind: "actionSubmitted", roundNumber: 1, characterId: "c-mira", text: "Open the door.", revision: 1 },
      { kind: "narrationRecorded", roundNumber: 0, text: "A draught stirs." },
      { kind: "actionSubmitted", roundNumber: 1, characterId: "c-mira", text: "Pick the lock instead.", revision: 2 },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["action", "narration"]);
    expect(entries[0]).toMatchObject({ text: "Pick the lock instead." });
  });

  it("names a place change by its scene title, and marks where a fight begins and ends", () => {
    const entries = story([
      { kind: "sceneTransitioned", roundNumber: 2, sceneId: "scene:chapel" },
      { kind: "encounterEnded", outcome: "victory" },
    ]);
    expect(entries).toMatchObject([
      { kind: "system", code: "scene", text: "The Drowned Chapel" },
      { kind: "system", code: "victory" },
    ]);
  });

  it("leaves out empty tellings and keeps only the newest entries", () => {
    const many: CampaignEvent[] = Array.from({ length: storyLength + 10 }, (_, n) => ({ kind: "narrationRecorded", roundNumber: n, text: `Telling ${n}` }));
    many.push({ kind: "narrationRecorded", roundNumber: 99, text: "   " });
    const entries = story(many);
    expect(entries).toHaveLength(storyLength);
    expect(entries.at(-1)).toMatchObject({ text: `Telling ${storyLength + 9}` });
  });

  it("carries nothing from a private summary or a hidden note", () => {
    const entries = story([{ kind: "summaryRecorded", throughRound: 3, visibility: "private", text: "The DM's secret." }]);
    expect(entries).toEqual([]);
  });
});
