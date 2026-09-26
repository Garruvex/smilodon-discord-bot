import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, newCampaign, organizer, reject, run } from "./campaign-fixtures.js";
import { startedFight } from "./combat-fixtures.js";

// Mira carries a shortsword, shortbow and leather armor; Borin a longsword,
// chain mail and shield (see the fixtures).
function offered(state: CampaignState = newCampaign()): CampaignState {
  return run(state, alex, {
    kind: "offerItem",
    fromCharacterId: "c-mira",
    toCharacterId: "c-borin",
    give: "item:shortbow",
    want: null,
  }).state;
}

describe("giving and trading items", () => {
  it("moves nothing until the receiving hero's owner accepts", () => {
    const step = run(newCampaign(), alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null });
    expect(kinds(step.events)).toEqual(["itemOffered"]);
    expect(step.requests).toContainEqual({ kind: "deliver", delivery: { kind: "itemOffered", offerId: "offer:1" } });
    expect(step.state.characters["c-mira"]?.equipment).toContain("item:shortbow");

    const accepted = run(step.state, jamie, { kind: "respondToOffer", offerId: "offer:1", accept: true }).state;
    expect(accepted.characters["c-mira"]?.equipment).not.toContain("item:shortbow");
    expect(accepted.characters["c-borin"]?.equipment).toContain("item:shortbow");
    expect(accepted.offers).toEqual({});
  });

  it("swaps two items when the offer asks for one in return", () => {
    const offer = run(newCampaign(), alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortsword", want: "item:shield" }).state;
    const done = run(offer, jamie, { kind: "respondToOffer", offerId: "offer:1", accept: true }).state;
    expect(done.characters["c-mira"]?.equipment).toContain("item:shield");
    expect(done.characters["c-mira"]?.equipment).not.toContain("item:shortsword");
    expect(done.characters["c-borin"]?.equipment).toContain("item:shortsword");
    expect(done.characters["c-borin"]?.equipment).not.toContain("item:shield");
  });

  it("lets the receiver decline and the giver cancel, and only they may", () => {
    const state = offered();
    expect(reject(state, alex, { kind: "respondToOffer", offerId: "offer:1", accept: true })).toEqual({ code: "notYourCharacter" });
    expect(reject(state, jamie, { kind: "cancelOffer", offerId: "offer:1" })).toEqual({ code: "notYourCharacter" });
    expect(run(state, jamie, { kind: "respondToOffer", offerId: "offer:1", accept: false }).state.offers).toEqual({});
    expect(run(state, alex, { kind: "cancelOffer", offerId: "offer:1" }).state.offers).toEqual({});
    expect(reject(state, jamie, { kind: "respondToOffer", offerId: "offer:9", accept: true })).toEqual({ code: "unknownOffer" });
  });

  it("refuses items a hero does not hold, offers for someone else's hero, and offers to oneself", () => {
    const give = { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", want: null } as const;
    expect(reject(newCampaign(), alex, { ...give, give: "item:longsword" })).toEqual({ code: "itemNotHeld" });
    expect(reject(newCampaign(), alex, { ...give, give: "item:shortbow", want: "item:mace" })).toEqual({ code: "itemNotHeld" });
    expect(reject(newCampaign(), jamie, { ...give, give: "item:shortbow" })).toEqual({ code: "notYourCharacter" });
    expect(reject(newCampaign(), alex, { ...give, toCharacterId: "c-mira", give: "item:shortbow" })).toEqual({ code: "invalidOffer" });
  });

  it("closes an offer whose item has since gone, instead of moving anything", () => {
    const state = offered();
    const stashed = run(state, alex, { kind: "stashItem", characterId: "c-mira", itemId: "item:shortbow" }).state;
    const step = run(stashed, jamie, { kind: "respondToOffer", offerId: "offer:1", accept: true });
    expect(step.events).toEqual([{ kind: "offerClosed", offerId: "offer:1", reason: "unavailable" }]);
    expect(step.state.characters["c-borin"]?.equipment).not.toContain("item:shortbow");
  });

  it("does not stash or take items during a fight", () => {
    const fight = startedFight();
    expect(reject(fight.state, alex, { kind: "stashItem", characterId: "c-mira", itemId: "item:shortbow" })).toEqual({ code: "inCombat" });
  });
});

describe("the party stash", () => {
  it("takes an item from a hero and hands it to another, by the owner or the organizer", () => {
    const stashed = run(newCampaign(), alex, { kind: "stashItem", characterId: "c-mira", itemId: "item:shortbow" }).state;
    expect(stashed.stash).toEqual(["item:shortbow"]);
    expect(reject(stashed, jamie, { kind: "takeFromStash", characterId: "c-mira", itemId: "item:shortbow" })).toEqual({ code: "notYourCharacter" });
    const taken = run(stashed, jamie, { kind: "takeFromStash", characterId: "c-borin", itemId: "item:shortbow" }).state;
    expect(taken.stash).toEqual([]);
    expect(taken.characters["c-borin"]?.equipment).toContain("item:shortbow");
    const gifted = run(stashed, organizer, { kind: "takeFromStash", characterId: "c-mira", itemId: "item:shortbow" }).state;
    expect(gifted.characters["c-mira"]?.equipment).toContain("item:shortbow");
    expect(reject(taken, organizer, { kind: "takeFromStash", characterId: "c-mira", itemId: "item:shortbow" })).toEqual({ code: "itemNotHeld" });
  });

  it("changes armor class from the next fight on", () => {
    const stripped = run(newCampaign(), jamie, { kind: "stashItem", characterId: "c-borin", itemId: "item:shield" }).state;
    const fight = startedFight(stripped);
    const withShield = startedFight();
    expect(fight.encounter.combatants["c-borin"]?.armorClass).toBe((withShield.encounter.combatants["c-borin"]?.armorClass ?? 0) - 2);
  });
});

const potion = "item:potion-of-healing" as const;

// Mira holds a potion and has 3 of her 9 HP.
function woundedMira(): CampaignState {
  const base = newCampaign();
  const sheet = base.characters["c-mira"];
  if (sheet === undefined) throw new Error("fixture");
  return {
    ...base,
    characters: { ...base.characters, "c-mira": { ...sheet, equipment: [...sheet.equipment, potion] } },
    heroStatus: { "c-mira": { hp: 3, resources: { spellSlots: {}, featureUses: {} } } },
  };
}

describe("potions", () => {
  it("heals outside combat, up to the maximum, and is used up", () => {
    const step = run(woundedMira(), alex, { kind: "useItem", characterId: "c-mira", itemId: potion });
    expect(step.events).toEqual([{ kind: "itemUsed", characterId: "c-mira", itemId: potion, healed: 6 }]);
    expect(step.state.heroStatus["c-mira"]?.hp).toBe(9);
    expect(step.state.characters["c-mira"]?.equipment).not.toContain(potion);
    expect(reject(step.state, alex, { kind: "useItem", characterId: "c-mira", itemId: potion })).toEqual({ code: "itemNotHeld" });
  });

  it("refuses items that are not potions and other players' heroes", () => {
    expect(reject(woundedMira(), alex, { kind: "useItem", characterId: "c-mira", itemId: "item:shortbow" })).toEqual({ code: "notUsable" });
    expect(reject(woundedMira(), jamie, { kind: "useItem", characterId: "c-mira", itemId: potion })).toEqual({ code: "notYourCharacter" });
  });

  it("costs an action in a fight, and heals the fighter", () => {
    const fight = startedFight(woundedMira());
    fight.run(alex, { kind: "combatUseItem", combatantId: "c-mira", itemId: potion });
    expect(fight.encounter.combatants["c-mira"]?.hp).toBe(9);
    expect(reject(fight.state, alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" })).toEqual({ code: "noActionLeft" });
    expect(reject(fight.state, alex, { kind: "useItem", characterId: "c-mira", itemId: potion })).toEqual({ code: "inCombat" });
  });
});

describe("hand-overs in a fight", () => {
  it("cost the giver's bonus action, need the receiver's yes, and change the receiver's attacks", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null });
    expect(fight.encounter.combatants["c-mira"]?.budget.bonusAction).toBe(false);
    expect(fight.encounter.combatants["c-borin"]?.attacks.map((attack) => attack.weapon)).not.toContain("item:shortbow");
    fight.run(jamie, { kind: "respondToOffer", offerId: "offer:1", accept: true });
    expect(fight.encounter.combatants["c-borin"]?.attacks.map((attack) => attack.weapon)).toContain("item:shortbow");
    expect(fight.encounter.combatants["c-mira"]?.attacks.map((attack) => attack.weapon)).not.toContain("item:shortbow");
  });

  it("are refused off the giver's turn, between zones, or with no bonus action left", () => {
    const fight = startedFight();
    expect(reject(fight.state, jamie, { kind: "offerItem", fromCharacterId: "c-borin", toCharacterId: "c-mira", give: "item:shield", want: null })).toEqual({ code: "notYourTurn" });
    fight.run(alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null });
    expect(reject(fight.state, alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortsword", want: null })).toEqual({ code: "noActionLeft" });
  });

  it("fail when the heroes have parted before the receiver answers", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null });
    fight.run(alex, { kind: "combatMove", combatantId: "c-mira", zoneId: "courtyard" });
    fight.run(jamie, { kind: "respondToOffer", offerId: "offer:1", accept: true });
    expect(fight.events.at(-1)).toEqual({ kind: "offerClosed", offerId: "offer:1", reason: "unavailable" });
  });
});
