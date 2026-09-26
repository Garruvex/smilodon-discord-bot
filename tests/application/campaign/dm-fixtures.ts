import type { AdventureBible } from "../../../src/domain/campaign/adventure/adventure-bible.js";

// Distinctive strings, so tests can scan payloads for leaks.
export const secrets = {
  overview: "SECRET-OVERVIEW-the-mayor-hired-the-bandits",
  dmNotes: "SECRET-NOTES-the-ledger-is-under-the-floor",
  npc: "SECRET-NPC-garrick-is-a-smuggler",
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
};
