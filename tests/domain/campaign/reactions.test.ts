import { describe, expect, it } from "vitest";

import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, organizer, partyOfThree, sam, system } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Reactions (Shield): a hit that its target could turn into a miss waits for the
// target's answer. Elspeth, made a wizard for these tests, has Shield prepared.

function wizardParty(): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  const casting = elspeth?.spellcasting;
  if (elspeth === undefined || casting === undefined || casting === null) throw new Error("elspeth");
  return { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, spellcasting: { ...casting, spells: [...casting.spells, "spell:shield" as const] } } } };
}

// Initiative: Elspeth 20 (armor class 18), Mira, goblin A, Borin, goblin B. Elspeth and Mira end their
// turns, and goblin A shoots the weakest hero, Elspeth, with the given d20 (+4 to hit).
function goblinShoots(d20: number, state: CampaignState = wizardParty()): Fight {
  return new Fight(state)
    .rolls([5, 4, 20, 3, 2])
    .run(organizer, { kind: "startEncounter", spec: skirmish })
    .run(sam, { kind: "endTurn", combatantId: "c-elspeth" })
    .rolls([d20])
    .run(alex, { kind: "endTurn", combatantId: "c-mira" });
}

const ofKind = <K extends CampaignEvent["kind"]>(fight: Fight, kind: K): Extract<CampaignEvent, { kind: K }>[] =>
  fight.events.filter((event): event is Extract<CampaignEvent, { kind: K }> => event.kind === kind);

describe("the reaction window", () => {
  it("opens when a hit could become a miss, holding the attack until the target answers", () => {
    const fight = goblinShoots(15);
    // 15 + 4 = 19 hits armor class 18, but not 23.
    const offered = ofKind(fight, "reactionOffered");
    expect(offered).toHaveLength(1);
    expect(offered[0]?.reaction).toMatchObject({ targetId: "c-elspeth", options: [{ spellId: "spell:shield", slotLevel: 1 }], roll: { total: 19 } });
    expect(fight.encounter.resolution?.reaction).toMatchObject({ targetId: "c-elspeth" });
    // Nothing is decided: no result, no damage, the goblin's action is still open.
    expect(fight.events.filter((event) => event.kind === "checkRolled" && event.targetId === "c-elspeth")).toEqual([]);
    expect(fight.combatant("c-elspeth").hp).toBe(9);
    expect(fight.requests).toContainEqual({ kind: "deliver", delivery: { kind: "reactionOffered", encounterId: "enc-1", attackId: fight.encounter.resolution?.id } });
    expect(fight.requests.some((request) => request.kind === "startTimer" && request.timer.kind === "combatReaction")).toBe(true);
  });

  it("does not open for a miss, a hit no reaction could stop, or a natural 20", () => {
    for (const d20 of [2, 19]) expect(ofKind(goblinShoots(d20), "reactionOffered")).toEqual([]);
    // 18 + 4 = 22 would still hit armor class 23? No: 22 < 23, so the window opens; 19 + 4 = 23 does not.
    expect(ofKind(goblinShoots(18), "reactionOffered")).toHaveLength(1);
    expect(ofKind(goblinShoots(20), "reactionOffered")).toEqual([]);
  });

  it("turns the hit into a miss when the target casts Shield, spending the reaction and a slot", () => {
    const fight = goblinShoots(15);
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" });
    const shield = fight.combatant("c-elspeth");
    expect(shield.hp).toBe(9);
    expect(shield.budget.reaction).toBe(false);
    expect(shield.resources.spellSlots).toEqual({ 1: 1 });
    // The attack was settled against armor class 23 and missed.
    expect(ofKind(fight, "checkRolled").find((event) => event.targetId === "c-elspeth")).toMatchObject({ landed: false });
    expect(fight.events.map((event) => event.kind)).toContain("reactionAnswered");
    // +5 armor class, until the start of her next turn (her turn came earlier this round, so round 2).
    expect(shield.effects).toMatchObject([{ definition: "spell:shield", modifiers: [{ kind: "acBonus", amount: 5 }], clock: { follows: "target", boundary: "start", untilRound: 2 } }]);
    // It stops the timer, and the fight carries on.
    expect(fight.requests.some((request) => request.kind === "cancelTimer" && request.timerId.startsWith("reaction:"))).toBe(true);
    expect(fight.encounter.resolution).toBeNull();
    expect(fight.current).not.toBe("c-elspeth");
  });

  it("lets the hit land when the target declines", () => {
    const fight = goblinShoots(15).rolls([], [3, 3]);
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: null });
    expect(fight.combatant("c-elspeth").hp).toBeLessThan(9);
    expect(fight.combatant("c-elspeth").budget.reaction).toBe(true);
    expect(fight.combatant("c-elspeth").resources.spellSlots).toEqual({ 1: 2 });
    expect(ofKind(fight, "checkRolled").find((event) => event.targetId === "c-elspeth")).toMatchObject({ landed: true });
  });

  it("declines by itself when its timer runs out, and only for the timer", () => {
    const fight = goblinShoots(15).rolls([], [3, 3]);
    const resolutionId = fight.encounter.resolution?.id ?? "";
    expect(fight.reject(alex, { kind: "reactionTimerExpired", encounterId: "enc-1", resolutionId })).toEqual({ code: "systemOnly" });
    // A timer for some other window does nothing.
    fight.run(system, { kind: "reactionTimerExpired", encounterId: "enc-1", resolutionId: "enc-1:act:999" });
    expect(fight.encounter.resolution?.reaction).not.toBeNull();
    fight.run(system, { kind: "reactionTimerExpired", encounterId: "enc-1", resolutionId });
    expect(fight.combatant("c-elspeth").hp).toBeLessThan(9);
    expect(fight.combatant("c-elspeth").budget.reaction).toBe(true);
  });

  it("declines when the target's player goes away with the window open", () => {
    const fight = goblinShoots(15).rolls([], [3, 3]);
    fight.run(sam, { kind: "markAway", userId: "u-sam" });
    expect(fight.encounter.resolution?.reaction ?? null).toBeNull();
    expect(fight.combatant("c-elspeth").hp).toBeLessThan(9);
  });

  it("asks nobody whose player is away, who has no reaction left, or who has no reaction spell", () => {
    const away = new Fight(wizardParty()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    away.run(sam, { kind: "endTurn", combatantId: "c-elspeth" }).run(sam, { kind: "markAway", userId: "u-sam" }).rolls([15]);
    away.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(ofKind(away, "reactionOffered")).toEqual([]);

    const spent = new Fight(wizardParty()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    spent.state = {
      ...spent.state,
      encounter: spent.state.encounter === null ? null : { ...spent.state.encounter, combatants: { ...spent.state.encounter.combatants, "c-elspeth": { ...spent.encounter.combatants["c-elspeth"]!, budget: { ...spent.encounter.combatants["c-elspeth"]!.budget, reaction: false } } } },
    };
    spent.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    // The budget refreshes only on her own turn, so it is still spent when the goblin shoots.
    spent.rolls([15], [3, 3]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(ofKind(spent, "reactionOffered")).toEqual([]);

    // Without Shield prepared there is nothing to ask.
    const plain = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    plain.run(sam, { kind: "endTurn", combatantId: "c-elspeth" }).rolls([15], [3, 3]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(ofKind(plain, "reactionOffered")).toEqual([]);
  });

  it("refuses answers from the wrong player, for a spell not offered, or when nothing waits", () => {
    const fight = goblinShoots(15);
    expect(fight.reject(alex, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" })).toEqual({ code: "notYourCharacter" });
    expect(fight.reject(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:bless" })).toEqual({ code: "unknownSpell" });
    expect(fight.reject(alex, { kind: "combatReact", combatantId: "c-mira", spellId: null })).toEqual({ code: "noReaction" });
    // While the window is open nobody else can start anything.
    expect(fight.reject(sam, { kind: "endTurn", combatantId: "c-elspeth" })).toEqual({ code: "notYourTurn" });
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: null });
    expect(fight.reject(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" })).toEqual({ code: "noReaction" });
  });

  it("lets the shield lapse at the start of the caster's next turn", () => {
    const fight = goblinShoots(15);
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" });
    expect(fight.combatant("c-elspeth").effects).toHaveLength(1);
    // Finish round 1 (Borin, goblin B), and Elspeth's turn in round 2 begins.
    fight.rolls([2, 2, 2, 2], [1, 1]);
    while (fight.current !== "c-elspeth") {
      const id = fight.current ?? "";
      const owner = id === "c-mira" ? alex : { kind: "user", userId: "u-jamie" } as const;
      if (id === "c-mira" || id === "c-borin") fight.run(owner, { kind: "endTurn", combatantId: id });
      else fight.run(organizer, { kind: "turnTimerExpired", encounterId: "enc-1", turnNumber: fight.encounter.turnNumber });
    }
    expect(fight.encounter.round).toBe(2);
    expect(fight.combatant("c-elspeth").effects).toEqual([]);
    expect(fight.combatant("c-elspeth").budget.reaction).toBe(true);
  });
});

describe("a window across a pause or a restart", () => {
  it("survives being saved and loaded, and answers exactly as it would have", () => {
    const fight = goblinShoots(15).rolls([], [3, 3]);
    const stored = JSON.parse(JSON.stringify(fight.state)) as CampaignState;
    const reloaded = new Fight(stored);
    reloaded.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" });
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" });
    expect(reloaded.combatant("c-elspeth")).toEqual(fight.combatant("c-elspeth"));
    expect(reloaded.combatant("c-elspeth").hp).toBe(9);
  });

  it("waits while the table is empty, and gets a fresh timer when play continues", () => {
    const fight = goblinShoots(15).rolls([], [3, 3]);
    // The other players leave; Elspeth's player is the last one, and the organizer pauses.
    fight.run(organizer, { kind: "pauseCampaign", reason: "organizer" });
    expect(fight.reject(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" })).toEqual({ code: "campaignPaused" });
    // A timer firing meanwhile does nothing.
    fight.run(system, { kind: "reactionTimerExpired", encounterId: "enc-1", resolutionId: fight.encounter.resolution?.id ?? "" });
    expect(fight.encounter.resolution?.reaction).not.toBeNull();
    const before = fight.requests.length;
    fight.run(organizer, { kind: "continue" });
    expect(fight.requests.slice(before).some((request) => request.kind === "startTimer" && request.timer.kind === "combatReaction")).toBe(true);
    fight.run(sam, { kind: "combatReact", combatantId: "c-elspeth", spellId: "spell:shield" });
    expect(fight.combatant("c-elspeth").hp).toBe(9);
  });
});
