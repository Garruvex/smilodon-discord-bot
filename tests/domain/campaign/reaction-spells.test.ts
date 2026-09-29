import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Hellish Rebuke and Counterspell: reaction spells that answer damage and a foe's spell.

function withSpells(spells: readonly string[], slots: Readonly<Record<number, number>>): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  const casting = elspeth?.spellcasting;
  if (elspeth === undefined || casting === undefined || casting === null) throw new Error("elspeth");
  const status = base.heroStatus["c-elspeth"];
  return {
    ...base,
    characters: { ...base.characters, "c-elspeth": { ...elspeth, spellcasting: { ...casting, spells: [...casting.spells, ...spells] as typeof casting.spells, slots: { ...casting.slots, ...slots } } } },
    heroStatus: status === undefined ? base.heroStatus : { ...base.heroStatus, "c-elspeth": { ...status, resources: { ...status.resources, spellSlots: { ...status.resources.spellSlots, ...slots } } } },
  };
}

const ofKind = <K extends CampaignEvent["kind"]>(fight: Fight, kind: K): Extract<CampaignEvent, { kind: K }>[] =>
  fight.events.filter((event): event is Extract<CampaignEvent, { kind: K }> => event.kind === kind);

// Initiative: Elspeth 20, Mira, goblin A, Borin, goblin B. Goblin A shoots Elspeth (the weakest) and hits.
function goblinHurtsElspeth(state: CampaignState): Fight {
  return new Fight(state)
    .rolls([5, 4, 20, 3, 2])
    .run(organizer, { kind: "startEncounter", spec: skirmish })
    .run(sam, { kind: "endTurn", combatantId: "c-elspeth" })
    .rolls([15], [3])
    .run(alex, { kind: "endTurn", combatantId: "c-mira" });
}

describe("Hellish Rebuke", () => {
  it("opens a window once a foe has hurt the hero, and burns the attacker when cast", () => {
    const fight = goblinHurtsElspeth(withSpells(["spell:hellish-rebuke"], {}));
    const offered = ofKind(fight, "reactionOffered");
    expect(offered).toHaveLength(1);
    expect(offered[0]?.reaction).toMatchObject({ trigger: "damage", targetId: "c-elspeth", options: [{ spellId: "spell:hellish-rebuke", slotLevel: 1 }] });
    expect(fight.combatant("c-elspeth").hp).toBeLessThan(9);
    // The goblin fails its Dexterity save (3) and takes 2d10 fire damage (5 + 5), enough to fell it.
    const slotsBefore = fight.combatant("c-elspeth").resources.spellSlots[1] ?? 0;
    fight.rolls([3], [5, 5]).run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:hellish-rebuke" });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-elspeth").budget.reaction).toBe(false);
    expect(fight.combatant("c-elspeth").resources.spellSlots[1]).toBe(slotsBefore - 1);
    expect(fight.encounter.resolution).toBeNull();
  });

  it("lets the moment pass when the hero declines, spending nothing", () => {
    const fight = goblinHurtsElspeth(withSpells(["spell:hellish-rebuke"], {}));
    const slotsBefore = fight.combatant("c-elspeth").resources.spellSlots[1] ?? 0;
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: null });
    expect(fight.combatant("goblin-a").hp).toBe(7);
    expect(fight.combatant("c-elspeth").resources.spellSlots[1]).toBe(slotsBefore);
    expect(fight.encounter.resolution).toBeNull();
  });
});

describe("Counterspell", () => {
  const casterFight: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:archmage", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };

  it("offers to counter a spell a foe is casting, before anything is rolled for it", () => {
    const fight = new Fight(withSpells(["spell:counterspell"], { 5: 1 })).rolls([5, 4, 20, 3]).run(organizer, { kind: "startEncounter", spec: casterFight });
    // The heroes end their turns; the archmage's spell then opens the window.
    const owners = { "c-elspeth": sam, "c-mira": alex, "c-borin": jamie } as const;
    for (let turns = 0; turns < 3; turns += 1) {
      const id = fight.current as keyof typeof owners;
      if (owners[id] === undefined) break;
      fight.rolls([15], [4, 4, 4]).run(owners[id], { kind: "endTurn", combatantId: id });
    }
    const offered = ofKind(fight, "reactionOffered").find((event) => event.reaction.trigger === "spell");
    expect(offered).toBeDefined();
    expect(offered?.reaction).toMatchObject({ trigger: "spell", targetId: "c-elspeth", roll: null });
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:counterspell" });
    expect(ofKind(fight, "spellCountered")).toHaveLength(1);
    expect(fight.combatant("c-elspeth").resources.spellSlots[5]).toBe(0);
    expect(fight.encounter.resolution).toBeNull();
  });
});
