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

  it("does not change gear during a fight", () => {
    const fight = startedFight();
    expect(reject(fight.state, alex, { kind: "offerItem", fromCharacterId: "c-mira", toCharacterId: "c-borin", give: "item:shortbow", want: null })).toEqual({ code: "inCombat" });
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
