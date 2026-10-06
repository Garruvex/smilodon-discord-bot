import { describe, expect, it } from "vitest";

import { parseAdventureDocument } from "../../../src/application/campaign/adventures/adventure-document.js";
import { dump } from "../../../src/application/campaign/adventures/adventure-catalog.js";
import { buildStartingState } from "../../../src/application/campaign/setup/starting-state.js";
import { xpThresholds } from "../../../src/domain/campaign/character/leveling.js";
import { encounterSpec } from "../../../src/domain/campaign/adventure/adventure-bible.js";
import { starter } from "./campaign-rig.js";

const pacing = { roundSeconds: null, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 };
const seatsOf = (count: number): { userId: string; heroId: string }[] => starter.en.heroes.slice(0, count).map((hero, index) => ({ userId: `u-${index}`, heroId: hero.id }));

describe("a game that starts above level 1", () => {
  it("brings every preset hero up to the starting level, ready for the player's choices", () => {
    const state = buildStartingState({ campaignId: "c-1", organizerId: "u-0", adventure: starter.en, seats: seatsOf(2), pacing, startingLevel: 4 });
    for (const sheet of Object.values(state.characters)) {
      expect(sheet.level).toBe(4);
      expect(sheet.xp).toBe(xpThresholds[3]);
      expect(sheet.pendingAsi).toBe(1);
      expect(sheet.maxHp).toBeGreaterThan(starter.en.heroes.find((hero) => hero.id === sheet.id)?.maxHp ?? Infinity);
    }
  });

  it("leaves heroes at level 1 when no level is asked for", () => {
    const state = buildStartingState({ campaignId: "c-1", organizerId: "u-0", adventure: starter.en, seats: seatsOf(1), pacing });
    expect(Object.values(state.characters).map((sheet) => sheet.level)).toEqual([1]);
  });
});

describe("the levels an adventure can carry", () => {
  it("reads a starting level and an encounter's milestone, and writes them back the same", () => {
    const document = starter.en;
    const encounter = document.bible.encounters[0];
    if (encounter === undefined) throw new Error("the starter adventure has an encounter");
    const leveled = { ...document, bible: { ...document.bible, startingLevel: 3, encounters: [{ ...encounter, milestoneLevel: 4 }, ...document.bible.encounters.slice(1)] } };
    const parsed = parseAdventureDocument(dump(leveled));
    expect(parsed.bible.startingLevel).toBe(3);
    expect(parsed.bible.encounters[0]?.milestoneLevel).toBe(4);
    expect(encounterSpec(parsed.bible.encounters[0] ?? encounter).milestoneLevel).toBe(4);
    expect(parsed).toEqual(leveled);
  });

  it("stays absent when an adventure names neither", () => {
    expect(starter.en.bible).not.toHaveProperty("startingLevel");
    expect(encounterSpec(starter.en.bible.encounters[0] ?? (undefined as never))).not.toHaveProperty("milestoneLevel");
  });

  it("refuses a starting level outside 1 to 10", () => {
    const text = dump({ ...starter.en, bible: { ...starter.en.bible, startingLevel: 11 } });
    expect(() => parseAdventureDocument(text)).toThrow(/startingLevel/);
  });
});
