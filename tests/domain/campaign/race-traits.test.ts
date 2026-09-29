import { describe, expect, it } from "vitest";
import { hasSaveAdvantage, relentlessEnduranceKey, type SaveContext, type Trait } from "../../../src/domain/campaign/rules/traits.js";
import { traitsOf } from "../../../src/domain/campaign/rules/content-definitions.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign, organizer, ruleset } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

const nothing: SaveContext = { conditions: [], damageTypes: [], magic: false };
const raceTraits = (id: `race:${string}`): readonly Trait[] => traitsOf(ruleset().content.get(id));

describe("racial save advantage", () => {
  it("gives elves and half-elves advantage against being charmed, and nothing else", () => {
    for (const id of ["race:elf", "race:high-elf", "race:wood-elf", "race:drow", "race:half-elf"] as const) {
      expect(hasSaveAdvantage(raceTraits(id), "wis", { ...nothing, conditions: ["condition:charmed"] })).toBe(true);
      expect(hasSaveAdvantage(raceTraits(id), "wis", { ...nothing, conditions: ["condition:frightened"] })).toBe(false);
    }
  });

  it("gives halflings advantage against being frightened", () => {
    for (const id of ["race:halfling", "race:lightfoot-halfling", "race:stout-halfling"] as const) {
      expect(hasSaveAdvantage(raceTraits(id), "wis", { ...nothing, conditions: ["condition:frightened"] })).toBe(true);
    }
  });

  it("gives dwarves advantage against poison, as a condition or as damage", () => {
    for (const id of ["race:dwarf", "race:hill-dwarf", "race:mountain-dwarf", "race:stout-halfling"] as const) {
      expect(hasSaveAdvantage(raceTraits(id), "con", { ...nothing, conditions: ["condition:poisoned"] })).toBe(true);
      expect(hasSaveAdvantage(raceTraits(id), "con", { ...nothing, damageTypes: ["poison"] })).toBe(true);
      expect(hasSaveAdvantage(raceTraits(id), "con", { ...nothing, damageTypes: ["fire"] })).toBe(false);
    }
  });

  it("gives gnomes advantage on Intelligence, Wisdom and Charisma saves against magic only", () => {
    const gnome = raceTraits("race:rock-gnome");
    expect(hasSaveAdvantage(gnome, "int", { ...nothing, magic: true })).toBe(true);
    expect(hasSaveAdvantage(gnome, "cha", { ...nothing, magic: true })).toBe(true);
    expect(hasSaveAdvantage(gnome, "dex", { ...nothing, magic: true })).toBe(false);
    expect(hasSaveAdvantage(gnome, "int", nothing)).toBe(false);
  });

  it("gives humans none", () => {
    expect(hasSaveAdvantage(raceTraits("race:human"), "wis", { conditions: ["condition:charmed"], damageTypes: ["poison"], magic: true })).toBe(false);
  });
});

describe("Half-Orc traits", () => {
  const halfOrcMira = (): CampaignState => {
    const base = newCampaign();
    const mira = base.characters["c-mira"];
    if (mira === undefined) throw new Error("fixture");
    return { ...base, characters: { ...base.characters, "c-mira": { ...mira, race: "race:half-orc" as const } } };
  };

  // The same fight as combat.test.ts's downedMira: goblin A crits Mira for 14 and she would drop.
  const fightWith = (state: CampaignState): Fight => new Fight(state).rolls([5, 4, 20, 19, 20, 1, 10], [6, 6]).run(organizer, { kind: "startEncounter", spec: skirmish });

  it("keeps a half-orc on 1 HP once, instead of dropping her", () => {
    const fight = fightWith(halfOrcMira());
    expect(fight.combatant("c-mira")).toMatchObject({ hp: 1, condition: "active" });
    expect(fight.combatant("c-mira").resources.featureUses[relentlessEnduranceKey]).toBe(0);
  });

  it("lets anyone else drop as usual", () => {
    expect(fightWith(newCampaign()).combatant("c-mira")).toMatchObject({ hp: 0, condition: "unconscious" });
  });
});
