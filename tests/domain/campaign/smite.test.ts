import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, newCampaign, organizer, system } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Divine Smite, decided after the hit lands (unlike declaring it up front on
// combatAttack's own smiteSlot, already covered at tests/domain/campaign/combat-features.test.ts).
// Gate and courtyard 10 ft apart, so Borin can move and engage in one go.
const close: EncounterSpec = { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 10 }] };

function withDivineSmite(slots: Record<number, number> = { 1: 1 }): CampaignState {
  const base = newCampaign();
  const borin = base.characters["c-borin"];
  if (borin === undefined) throw new Error("fixture");
  const smiter = { ...borin, features: [...borin.features, "feature:divine-smite" as const], spellcasting: { ability: "cha" as const, spells: [], slots } };
  return { ...base, characters: { ...base.characters, "c-borin": smiter } };
}

// Borin moves, engages the goblin, then swings without declaring smite up
// front. A natural 20 is a certain hit no reaction could stop.
function borinHits(state: CampaignState = withDivineSmite()): Fight {
  return new Fight(state)
    .rolls([1, 20, 5, 4])
    .run(organizer, { kind: "startEncounter", spec: close })
    .run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" })
    .run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" })
    .rolls([20])
    .run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
}

const ofKind = <K extends CampaignEvent["kind"]>(fight: Fight, kind: K): Extract<CampaignEvent, { kind: K }>[] =>
  fight.events.filter((event): event is Extract<CampaignEvent, { kind: K }> => event.kind === kind);

describe("the smite window", () => {
  it("opens on a landed melee hit that didn't declare smite up front, holding even the weapon's own damage", () => {
    const fight = borinHits();
    const offered = ofKind(fight, "smiteOffered");
    expect(offered).toHaveLength(1);
    expect(offered[0]?.smite).toMatchObject({ targetId: "goblin-a", options: [{ slotLevel: 1 }] });
    expect(fight.encounter.resolution?.smite).toMatchObject({ targetId: "goblin-a" });
    // Nothing is dealt yet, not even the plain weapon hit: it all lands together once smite is answered.
    expect(fight.combatant("goblin-a").hp).toBe(7);
    expect(fight.requests).toContainEqual({ kind: "deliver", delivery: { kind: "smiteOffered", encounterId: "enc-1", attackId: fight.encounter.resolution?.id } });
    expect(fight.requests.some((request) => request.kind === "startTimer" && request.timer.kind === "combatSmite")).toBe(true);
  });

  it("does not open without the feature, without a slot left, or when a slot was already declared up front", () => {
    const noFeature = new Fight(newCampaign())
      .rolls([1, 20, 5, 4])
      .run(organizer, { kind: "startEncounter", spec: close })
      .run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" })
      .run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" })
      .rolls([20], [4])
      .run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    expect(ofKind(noFeature, "smiteOffered")).toEqual([]);
    expect(noFeature.combatant("goblin-a").hp).toBeLessThan(7);

    const noSlot = borinHits(withDivineSmite({ 1: 0 }));
    expect(ofKind(noSlot, "smiteOffered")).toEqual([]);

    const declaredUpFront = new Fight(withDivineSmite())
      .rolls([1, 20, 5, 4])
      .run(organizer, { kind: "startEncounter", spec: close })
      .run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" })
      .run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" })
      .rolls([20], [4, 3, 3])
      .run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword", smiteSlot: 1 });
    expect(ofKind(declaredUpFront, "smiteOffered")).toEqual([]);
  });

  it("adds the radiant damage and spends the slot when chosen after the hit", () => {
    const fight = borinHits();
    fight.rolls([], [4, 3, 3]).run(jamie, { kind: "combatSmite", combatantId: "c-borin", slotLevel: 1 });
    // Longsword 1d8 (4) + Dueling (2) + STR (3) = 9, Smite 2d8 (3, 3) = 6. 15 against 7 max HP: downed.
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-borin").resources.spellSlots).toEqual({ 1: 0 });
    expect(fight.encounter.resolution).toBeNull();
    expect(ofKind(fight, "smiteAnswered")).toEqual([{ kind: "smiteAnswered", resolutionId: expect.any(String) as string, combatantId: "c-borin", slotLevel: 1 }]);
  });

  it("deals only the weapon's own damage when skipped, spending nothing", () => {
    const fight = borinHits();
    fight.rolls([], [4]).run(jamie, { kind: "combatSmite", combatantId: "c-borin", slotLevel: null });
    // Longsword 1d8 (4) + Dueling (2) + STR (3) = 9 against 7 max HP: downed, but no smite dice were asked for.
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-borin").resources.spellSlots).toEqual({ 1: 1 });
  });

  it("refuses a slot that was never offered, and answering for someone else's hit", () => {
    const fight = borinHits();
    expect(fight.reject(jamie, { kind: "combatSmite", combatantId: "c-borin", slotLevel: 3 })).toEqual({ code: "unknownFeature" });
    expect(fight.reject(alex, { kind: "combatSmite", combatantId: "c-borin", slotLevel: 1 })).toEqual({ code: "notYourCharacter" });
    expect(fight.reject(jamie, { kind: "combatSmite", combatantId: "c-mira", slotLevel: null })).toEqual({ code: "noSmite" });
  });

  it("skips by itself when its timer runs out", () => {
    const fight = borinHits();
    const resolutionId = fight.encounter.resolution?.id ?? "";
    fight.rolls([], [4]).run(system, { kind: "smiteTimerExpired", encounterId: "enc-1", resolutionId });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-borin").resources.spellSlots).toEqual({ 1: 1 });
  });

  // Unlike Shield's target, a smite window is only ever open on the
  // attacker's own turn (right after their own attack lands), and a hero
  // cannot go away mid-own-turn at all (members.ts's mayGoAway already
  // refuses that with cannotLeaveNow) — so there is no "goes away with the
  // window open" case to cover here the way reactions.test.ts covers Shield.
  // declineSmiteFor exists for symmetry and for members.ts's other away
  // paths, exercised indirectly by the timer-expiry test above.
});
