import { describe, expect, it } from "vitest";

import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../src/domain/campaign/rules/content-registry.js";
import { buildActivityStory, storyBudget, storyMinimum } from "../../../src/application/campaign/views/activity-story.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { alex, newCampaign } from "../../domain/campaign/campaign-fixtures.js";
import { startedFight } from "../../domain/campaign/combat-fixtures.js";

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

  it("marks the viewer's own lines and no one else's", () => {
    const events: CampaignEvent[] = [
      { kind: "actionSubmitted", roundNumber: 1, characterId: "c-mira", text: "Raise the lantern.", revision: 1 },
      { kind: "heroSpoke", roundNumber: 1, characterId: "c-borin", text: "Stay close." },
    ];
    const entries = buildActivityStory(newCampaign(), events, bible, glossary, "c-mira");
    expect(entries[0]).toMatchObject({ kind: "action", mine: true });
    expect(entries[1]).not.toHaveProperty("mine");
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

  it("shows a spell cast between fights as who cast what, then the telling", () => {
    const state = { ...newCampaign(), characters: { "c-mira": { name: "Mira" } } } as unknown as ReturnType<typeof newCampaign>;
    const entries = buildActivityStory(state, [
      { kind: "utilitySpellCast", cast: { id: "cast-1", characterId: "c-mira", spellId: "spell:help" } },
      { kind: "utilityCastNarrated", castId: "cast-1", text: "The air hums." },
    ] as unknown as CampaignEvent[], bible, { names: { "spell:help": "Help" } } as unknown as Glossary);
    expect(entries).toEqual([{ id: "e1", kind: "cast", who: "Mira", spell: "Help", text: "The air hums." }]);
  });

  it("shows a conversation with an NPC as the question asked, then the telling", () => {
    const state = { ...newCampaign(), characters: { "c-mira": { name: "Mira" } } } as unknown as ReturnType<typeof newCampaign>;
    const withNpc = { scenes: [], npcs: [{ id: "npc:reni", name: "Reni" }] } as unknown as AdventureBible;
    const entries = buildActivityStory(state, [
      { kind: "dialogueSettled", revealSecret: false, dialogue: { id: "d1", characterId: "c-mira", npcId: "npc:reni", kind: "ask", question: "Who built it?", check: null } },
      { kind: "dialogueNarrated", dialogueId: "d1", text: "Monks, long ago." },
    ] as unknown as CampaignEvent[], withNpc, glossary);
    expect(entries).toEqual([{ id: "e1", kind: "talk", who: "Mira", npc: "Reni", question: "Who built it?", roll: null, text: "Monks, long ago." }]);
  });

  it("leaves out empty tellings", () => {
    expect(story([{ kind: "narrationRecorded", roundNumber: 1, text: "   " }])).toEqual([]);
  });

  it("keeps the newest entries within a size budget, but never fewer than a few", () => {
    const long = "x".repeat(3000);
    const many: CampaignEvent[] = Array.from({ length: 30 }, (_, n) => ({ kind: "narrationRecorded", roundNumber: n, text: `${n}:${long}` }));
    const entries = story(many);
    const size = entries.reduce((total, entry) => total + ("text" in entry && entry.text !== null ? entry.text.length + 80 : 80), 0);
    expect(entries.length).toBeGreaterThanOrEqual(storyMinimum);
    expect(entries.length).toBeLessThan(30);
    expect(size).toBeLessThanOrEqual(storyBudget + 3100 * 12);
    expect(entries.at(-1)).toMatchObject({ text: expect.stringMatching(/^29:/) });
  });

  it("cuts a telling from several rounds back to its opening and keeps the last rounds whole", () => {
    const long = `${"The cold wind rose over the old road. ".repeat(20)}`;
    const state = { ...newCampaign(), lastRoundNumber: 5 };
    const entries = buildActivityStory(state, [
      { kind: "narrationRecorded", roundNumber: 1, text: long },
      { kind: "narrationRecorded", roundNumber: 4, text: long },
      { kind: "narrationRecorded", roundNumber: 5, text: long },
    ], bible, glossary);
    expect(entries[0]).toMatchObject({ clipped: true });
    expect((entries[0] as { text: string }).text.length).toBeLessThan(long.length);
    expect(entries[1]).not.toHaveProperty("clipped");
    expect(entries[2]).not.toHaveProperty("clipped");
  });

  it("shows a settled check as the total against its DC", () => {
    const state = { ...newCampaign(), checks: { "check-1": { id: "check-1", characterId: "c-mira", test: { kind: "skill", skill: "arcana" }, dc: 15, roundNumber: 1, status: "resolved", result: null } } } as unknown as ReturnType<typeof newCampaign>;
    const entries = buildActivityStory(state, [{ kind: "checkResolved", checkId: "check-1", result: { roll: { total: 17, d20: { natural: 20 } }, success: true, moments: {} } } as unknown as CampaignEvent], bible, glossary);
    expect(entries).toEqual([{ id: "e0", kind: "roll", who: "Mira", test: { kind: "skill", skill: "arcana" }, total: 17, dc: 15, success: true }]);
  });

  it("keeps a roll in the story after a later round has cleared the state's checks", () => {
    const planned = { id: "check-1", characterId: "c-mira", test: { kind: "skill", skill: "animalHandling" }, dc: 12 };
    const entries = buildActivityStory(newCampaign(), [
      { kind: "roundPlanApplied", checks: [planned] },
      { kind: "checkResolved", checkId: "check-1", result: { roll: { total: 9 }, success: false } },
    ] as unknown as CampaignEvent[], bible, glossary);
    expect(entries).toEqual([{ id: "e1", kind: "roll", who: "Mira", test: planned.test, total: 9, dc: 12, success: false }]);
  });

  it("carries nothing from a private summary or a hidden note", () => {
    const entries = story([{ kind: "summaryRecorded", throughRound: 3, visibility: "private", text: "The DM's secret." }]);
    expect(entries).toEqual([]);
  });
});

describe("the Activity story in a fight", () => {
  const told = (fight: ReturnType<typeof startedFight>) => buildActivityStory(fight.state, fight.events, bible, enSrd51Glossary);

  it("tells where the fight began, what an attack did, and who fell", () => {
    const fight = startedFight().rolls([12], [5]);
    fight.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const entries = told(fight);
    expect(entries.map((entry) => entry.kind)).toEqual(["system", "combat", "alert"]);
    expect(entries[0]).toMatchObject({ code: "combatBegins" });
    expect(entries[1]).toMatchObject({ kind: "combat", who: "Mira", using: "Shortbow", source: "weapon", targets: [{ name: "Goblin A", check: "hit", damage: 8 }] });
    expect(entries[2]).toMatchObject({ kind: "alert", tone: "slain", name: "Goblin A" });
  });

  it("tells the turn's other moves: a dodge by name", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "combatDodge", combatantId: "c-mira" });
    expect(told(fight)).toContainEqual({ id: expect.any(String), kind: "maneuver", who: "Mira", maneuver: "dodge" });
  });

  it("reports a miss as a miss, with no call-out", () => {
    const fight = startedFight().rolls([2]);
    fight.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const combat = told(fight).find((entry) => entry.kind === "combat");
    expect(combat).toMatchObject({ targets: [{ name: "Goblin A", check: "miss", damage: 0 }] });
    expect(told(fight).some((entry) => entry.kind === "alert")).toBe(false);
  });
});
