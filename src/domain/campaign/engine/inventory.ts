import type { InventoryCommand } from "../commands/campaign-command.js";
import type { CharacterId } from "../core/ids.js";
import type { ContentId } from "../rules/content-id.js";
import { itemTrading } from "../rules/house-rules.js";
import { isFallen, type CampaignState, type ItemOffer } from "../state/campaign-state.js";
import { isWorn } from "../combat/combatant-profile.js";
import { canHandOver, refreshGear, startHandOver } from "./combat/combat-gear.js";
import type { Decision } from "./decision.js";
import { potionFor } from "./potions.js";
import type { Rejection } from "./rejection.js";

// Items move between heroes, and to and from the party stash, outside combat.
// Nothing is invented here: every item already sits in a hero's gear or the
// stash. A trade needs the receiving hero's owner to accept, so nobody is
// given or robbed of anything without saying yes. Armor class and attacks
// come from the gear at the start of each fight, so a moved item changes
// them from the next fight on.
export function handleInventoryCommand(decision: Decision, command: InventoryCommand): Rejection | null {
  const { state } = decision;
  if (decision.ctx.actor.kind !== "user") return { code: "notMember" };
  const inCombat = state.encounter !== null && state.encounter.status !== "ended";
  // In a fight only hand-overs between heroes standing together are allowed.
  if (inCombat && command.kind !== "offerItem" && command.kind !== "respondToOffer" && command.kind !== "cancelOffer") {
    return { code: "inCombat" };
  }
  switch (command.kind) {
    case "offerItem":
      return offerItem(decision, command);
    case "respondToOffer":
      return respondToOffer(decision, command.offerId, command.accept);
    case "cancelOffer":
      return cancelOffer(decision, command.offerId);
    case "stashItem": {
      const refusal = mayHandle(decision, command.characterId, false);
      if (refusal !== null) return refusal;
      if (!holds(state, command.characterId, command.itemId)) return { code: "itemNotHeld" };
      decision.emit({ kind: "itemStashed", characterId: command.characterId, itemId: command.itemId });
      return null;
    }
    case "useItem":
      return useItem(decision, command.characterId, command.itemId);
    case "wearItem":
    case "removeItem":
      return changeGear(decision, command.kind === "wearItem", command.characterId, command.itemId);
    case "takeFromStash": {
      const refusal = mayHandle(decision, command.characterId, true);
      if (refusal !== null) return refusal;
      if (!state.stash.includes(command.itemId)) return { code: "itemNotHeld" };
      decision.emit({ kind: "itemTaken", characterId: command.characterId, itemId: command.itemId });
      return null;
    }
  }
}

function offerItem(decision: Decision, command: Extract<InventoryCommand, { kind: "offerItem" }>): Rejection | null {
  const { state } = decision;
  if (decision.ctx.rules.houseRules.option(itemTrading) === "off") return { code: "tradingOff" };
  const { fromCharacterId, toCharacterId, give, want } = command;
  const refusal = mayHandle(decision, fromCharacterId, false);
  if (refusal !== null) return refusal;
  if (fromCharacterId === toCharacterId) return { code: "invalidOffer" };
  if (state.characters[toCharacterId] === undefined || isFallen(state, toCharacterId)) return { code: "heroFallen" };
  if (!holds(state, fromCharacterId, give)) return { code: "itemNotHeld" };
  if (want !== null && !holds(state, toCharacterId, want)) return { code: "itemNotHeld" };
  if (state.encounter !== null && state.encounter.status !== "ended") {
    const handOver = startHandOver(decision, fromCharacterId, toCharacterId);
    if (handOver !== null) return handOver;
  }
  const offer: ItemOffer = { id: `offer:${state.offerCount + 1}`, fromCharacterId, toCharacterId, give, want };
  decision.emit({ kind: "itemOffered", offer });
  decision.request({ kind: "deliver", delivery: { kind: "itemOffered", offerId: offer.id } });
  return null;
}

function respondToOffer(decision: Decision, offerId: string, accept: boolean): Rejection | null {
  const { state } = decision;
  const offer = state.offers[offerId];
  if (offer === undefined) return { code: "unknownOffer" };
  if (!actsFor(decision, offer.toCharacterId, false)) return { code: "notYourCharacter" };
  if (!accept) {
    decision.emit({ kind: "offerClosed", offerId, reason: "declined" });
    return null;
  }
  // Items may have moved since the offer was made, or the heroes parted in a fight.
  if (
    !holds(state, offer.fromCharacterId, offer.give) ||
    (offer.want !== null && !holds(state, offer.toCharacterId, offer.want)) ||
    !canHandOver(decision, offer.fromCharacterId, offer.toCharacterId)
  ) {
    decision.emit({ kind: "offerClosed", offerId, reason: "unavailable" });
    return null;
  }
  decision.emit({ kind: "offerAccepted", offerId });
  refreshGear(decision, [offer.fromCharacterId, offer.toCharacterId]);
  return null;
}

function useItem(decision: Decision, characterId: CharacterId, itemId: ContentId<"item">): Rejection | null {
  const refusal = mayHandle(decision, characterId, false);
  if (refusal !== null) return refusal;
  const { state } = decision;
  const potion = potionFor(state, decision.ctx.rules.content, characterId, itemId);
  if (potion === null) return { code: holds(state, characterId, itemId) ? "notUsable" : "itemNotHeld" };
  const sheet = state.characters[characterId];
  const hp = state.heroStatus[characterId]?.hp ?? sheet?.maxHp ?? 0;
  const healed = Math.max(0, Math.min(potion.healing, (sheet?.maxHp ?? 0) - hp));
  decision.emit({ kind: "itemUsed", characterId, itemId, healed });
  return null;
}

// Puts on or takes off armor or a shield. One armor and one shield at a time:
// a second has to wait until the first is off.
function changeGear(decision: Decision, putOn: boolean, characterId: CharacterId, itemId: ContentId<"item">): Rejection | null {
  const { state } = decision;
  const refusal = mayHandle(decision, characterId, false);
  if (refusal !== null) return refusal;
  const sheet = state.characters[characterId];
  if (sheet === undefined || !holds(state, characterId, itemId)) return { code: "itemNotHeld" };
  const content = decision.ctx.rules.content;
  const slotOf = (id: ContentId<"item">): "armor" | "shield" | null => {
    const definition = content.find(id);
    return definition?.kind === "item" && (definition.itemType === "armor" || definition.itemType === "shield") ? definition.itemType : null;
  };
  const slot = slotOf(itemId);
  if (slot === null) return { code: "notWearable" };
  const worn = sheet.equipment.filter((id) => slotOf(id) !== null && isWorn(sheet, content, id));
  const isWearing = worn.includes(itemId);
  if (putOn) {
    if (isWearing) return { code: "alreadyWorn" };
    if (worn.some((id) => slotOf(id) === slot)) return { code: "alreadyWearing" };
    decision.emit({ kind: "wornChanged", characterId, worn: [...worn, itemId] });
    return null;
  }
  if (!isWearing) return { code: "notWorn" };
  decision.emit({ kind: "wornChanged", characterId, worn: removeFirst(worn, itemId) });
  return null;
}

function removeFirst<T>(list: readonly T[], value: T): T[] {
  const index = list.indexOf(value);
  return index < 0 ? [...list] : [...list.slice(0, index), ...list.slice(index + 1)];
}

function cancelOffer(decision: Decision, offerId: string): Rejection | null {
  const offer = decision.state.offers[offerId];
  if (offer === undefined) return { code: "unknownOffer" };
  if (!actsFor(decision, offer.fromCharacterId, false)) return { code: "notYourCharacter" };
  decision.emit({ kind: "offerClosed", offerId, reason: "cancelled" });
  return null;
}

function holds(state: CampaignState, characterId: CharacterId, itemId: ContentId<"item">): boolean {
  return state.characters[characterId]?.equipment.includes(itemId) === true;
}

function actsFor(decision: Decision, characterId: CharacterId, organizerMay: boolean): boolean {
  const { actor } = decision.ctx;
  if (actor.kind !== "user") return false;
  if (organizerMay && actor.userId === decision.state.organizerId) return true;
  return decision.state.characters[characterId]?.ownerUserId === actor.userId;
}

// The hero exists, is alive, and the actor may handle their gear.
function mayHandle(decision: Decision, characterId: CharacterId, organizerMay: boolean): Rejection | null {
  if (!actsFor(decision, characterId, organizerMay)) return { code: "notYourCharacter" };
  if (isFallen(decision.state, characterId)) return { code: "heroFallen" };
  return null;
}
