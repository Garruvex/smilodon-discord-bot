import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";

// Distinctive strings, so tests can scan payloads for leaks.
export const secrets = {
  overview: "SECRET-OVERVIEW-the-mayor-hired-the-bandits",
  dmNotes: "SECRET-NOTES-the-ledger-is-under-the-floor",
  npc: "SECRET-NPC-garrick-is-a-smuggler",
  clock: "SECRET-CLOCK-the-guards-change-at-dusk",
  clue: "SECRET-CLUE-notes-reveal-after-two-failures",
  encounter: "SECRET-ENCOUNTER-start-when-they-open-the-trapdoor",
};

export const testBible: AdventureBible = {
  id: "test-adventure",
  version: "1",
  language: "en",
  title: "Moonlit Ruins",
  premise: "Bandits have been raiding the road to Oakvale.",
  dmOverview: secrets.overview,
  startScene: "scene:tavern",
  scenes: [
    {
      id: "scene:tavern",
      title: "The Crooked Lantern",
      publicDescription: "A smoky tavern full of nervous travelers.",
      dmNotes: secrets.dmNotes,
      npcIds: ["npc:garrick"],
    },
  ],
  npcs: [
    {
      id: "npc:garrick",
      name: "Garrick",
      voice: "Gruff, clipped sentences.",
      publicDescription: "The tavern keeper, polishing the same mug.",
      secret: secrets.npc,
    },
  ],
  clocks: [
    {
      id: "clock:guards-return",
      sceneId: "scene:tavern",
      name: "The guards return",
      segments: 3,
      dmNotes: secrets.clock,
      onFull: "encounter:cellar-goblins",
    },
  ],
  clues: [
    {
      id: "clue:cellar-key",
      sceneId: "scene:tavern",
      publicText: "A brass key hangs behind the bar.",
      dmNotes: secrets.clue,
    },
  ],
  encounters: [
    {
      id: "encounter:cellar-goblins",
      sceneId: "scene:tavern",
      publicDescription: "Goblins burst up through the cellar trapdoor.",
      dmNotes: secrets.encounter,
      zones: [
        { id: "bar", name: "Bar" },
        { id: "cellar", name: "Cellar" },
      ],
      edges: [{ from: "bar", to: "cellar", feet: 20 }],
      partyZoneId: "bar",
      monsters: [{ monsterId: "monster:goblin", zoneId: "cellar", npcId: null, fleeBelowHpFraction: null }],
      loot: [],
    },
  ],
};
