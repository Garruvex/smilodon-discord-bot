import { heroCombatant } from "../../combat/combatant-profile.js";
import { potionProblem, shieldProblem } from "../../combat/turn-rules.js";
import { isActive } from "../../combat/combat-state.js";
import type { CharacterId } from "../../core/ids.js";
import type { ContentId } from "../../rules/content-id.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, withHeroTurn } from "./combat-flow.js";
import { declareResolution } from "./resolution.js";

// Items in a fight. Handing an item to a hero in the same zone costs the
// giver a bonus action (their object interaction) and still needs the
// receiver's owner to accept; drinking a potion costs an action, or a bonus
// action under the BG3-style house rule.

// The giver's turn, a receiver who can act, standing in the same zone.
export function startHandOver(decision: Decision, fromId: CharacterId, toId: CharacterId): Rejection | null {
  return withHeroTurn(decision, fromId, (hero, encounter) => {
    const receiver = encounter.combatants[toId];
    if (receiver === undefined || receiver.side !== "party" || !isActive(receiver)) return { code: "invalidTarget" };
    if (receiver.zoneId !== hero.zoneId) return { code: "notAdjacent" };
    if (!hero.budget.bonusAction) return { code: "noActionLeft" };
    decision.emit({ kind: "actionTaken", combatantId: hero.id, action: "giveItem", bonus: true });
    return null;
  });
}

// An accepted offer can only complete while both heroes still stand together.
export function canHandOver(decision: Decision, fromId: CharacterId, toId: CharacterId): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null) return true;
  const from = encounter.combatants[fromId];
  const to = encounter.combatants[toId];
  return from !== undefined && to !== undefined && isActive(from) && isActive(to) && from.zoneId === to.zoneId;
}

// Armor class, attacks, and traits follow the gear a hero now holds.
export function refreshGear(decision: Decision, characterIds: readonly CharacterId[]): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  for (const id of characterIds) {
    const combatant = encounter.combatants[id];
    const sheet = decision.state.characters[id];
    if (combatant === undefined || sheet === undefined) continue;
    const fresh = heroCombatant(sheet, decision.ctx.rules.content, combatant.zoneId, { hp: combatant.hp, resources: combatant.resources });
    decision.emit({ kind: "gearChanged", combatantId: id, armorClass: fresh.armorClass, attacks: fresh.attacks, traits: fresh.traits });
  }
}

// A shield goes on or comes off as the hero's action. Armor stays as it is
// until the fight is over.
export function changeShieldInCombat(decision: Decision, combatantId: string, itemId: ContentId<"item">, putOn: boolean): Rejection | null {
  return withHeroTurn(decision, combatantId, (hero) => {
    if (hero.source.kind !== "hero") return { code: "notYourCharacter" };
    const characterId = hero.source.characterId;
    const checked = shieldProblem(decision.state.characters[characterId], decision.ctx.rules.content, hero, itemId, putOn);
    if ("problem" in checked) return checked.problem;
    decision.emit({ kind: "wornChanged", characterId, worn: checked.value.worn });
    refreshGear(decision, [characterId]);
    decision.emit({ kind: "actionTaken", combatantId: hero.id, action: "useItem", bonus: false });
    return null;
  });
}

export function useItemInCombat(decision: Decision, combatantId: string, itemId: ContentId<"item">): Rejection | null {
  return withHeroTurn(decision, combatantId, (hero) => {
    if (hero.source.kind !== "hero") return { code: "notYourCharacter" };
    const characterId = hero.source.characterId;
    const checked = potionProblem(decision.state.characters[characterId], decision.ctx.rules.content, decision.ctx.rules.houseRules, hero, itemId);
    if ("problem" in checked) return checked.problem;
    const { bonus, healing } = checked.value;
    const hp = Math.min(hero.maxHp, hero.hp + healing);
    decision.emit({ kind: "itemUsed", characterId, itemId, healed: hp - hero.hp });
    decision.emit({ kind: "actionTaken", combatantId: hero.id, action: "useItem", bonus });
    decision.request({ kind: "deliver", delivery: { kind: "combatBeat", encounterId: activeEncounter(decision)?.id ?? "", combatantId: hero.id, beat: "useItem" } });
    decision.emit({ kind: "combatantHpChanged", combatantId: hero.id, change: hp - hero.hp, hp, condition: "active", deathSaves: { successes: 0, failures: 0 }, cause: "healing" });
    // A potion with more to it than healing (resistance, heroism, speed) works through the same pipeline as a spell.
    const potion = decision.ctx.rules.content.find(itemId);
    const drinker = activeEncounter(decision)?.combatants[hero.id];
    if (potion?.kind === "item" && potion.itemType === "potion" && potion.effects !== undefined && drinker !== undefined) {
      declareResolution(decision, { actor: drinker, source: { kind: "item", itemId }, targetIds: [drinker.id], purpose: "action", cost: { action: false, bonusAction: false, reaction: false, spellSlot: null, featureUse: null } });
    }
    return null;
  });
}
