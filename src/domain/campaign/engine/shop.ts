import type { ShopCommand } from "../commands/campaign-command.js";
import { checkModifier, isSkill, type CheckTest } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import { resolveD20Test, rollMatchesSpec } from "../dice/d20-test.js";
import { classifyRollMoments } from "../dice/roll-moments.js";
import { resolveRollMode } from "../dice/roll.js";
import type { RollResult } from "../dice/roll-spec.js";
import { dcLadder } from "../rules/difficulty.js";
import { lootGold, naturalRollsOnChecks } from "../rules/house-rules.js";
import { isFallen, type PendingHaggle, type TradeRecord } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Buying, selling, and haggling with an NPC's shop, outside combat. Prices
// are trusted as given (campaign-command.ts's ShopCommand doc comment) —
// this file's only job is the hero's side: can they afford it, do they hold
// the item to sell, and — for a haggle — a genuine Persuasion, Deception, or
// Intimidation check against a fixed DC, the dice deciding the price, never
// the model asked to play the NPC. A settled trade (instant or haggled)
// always gets recorded for the Narrator to voice, win or lose.
export function handleShopCommand(decision: Decision, command: ShopCommand): Rejection | null {
  switch (command.kind) {
    case "buyItem":
      return instantTrade(decision, command.characterId, command.npcId, command.itemId, "buy", command.price);
    case "sellItem":
      return instantTrade(decision, command.characterId, command.npcId, command.itemId, "sell", command.price);
    case "hagglePrice":
      return startHaggle(decision, command);
    case "recordTradeNarration":
      return recordTradeNarration(decision, command.tradeId, command.text);
  }
}

// The skills SRD 5.1 actually uses to talk a price up or down.
const haggleSkills = ["persuasion", "deception", "intimidation"] as const;

function mayTrade(decision: Decision, characterId: CharacterId, npcId: TradeRecord["npcId"]): Rejection | null {
  const { state, ctx } = decision;
  if (state.npcsDown?.includes(npcId) === true) return { code: "npcDown" };
  if (ctx.actor.kind !== "user" || state.characters[characterId]?.ownerUserId !== ctx.actor.userId) return { code: "notYourCharacter" };
  if (isFallen(state, characterId)) return { code: "heroFallen" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  return null;
}

// What a hero can spend right now: the party's pooled purse, unless the
// "split" loot house rule is on, in which case it is their own share
// (rules/house-rules.ts's lootGold — the same option combat's own gold loot
// already reads). A shop's own funds are never tracked; it always has
// enough to buy back an item a hero sells.
function wallet(decision: Decision, characterId: CharacterId): { readonly kind: "pool" | "hero"; readonly gold: number } {
  const { state, ctx } = decision;
  if (ctx.rules.houseRules.option(lootGold) === "split") return { kind: "hero", gold: state.heroGold?.[characterId] ?? 0 };
  return { kind: "pool", gold: state.gold };
}

function instantTrade(
  decision: Decision,
  characterId: CharacterId,
  npcId: TradeRecord["npcId"],
  itemId: TradeRecord["itemId"],
  direction: "buy" | "sell",
  price: number,
): Rejection | null {
  const refusal = mayTrade(decision, characterId, npcId);
  if (refusal !== null) return refusal;
  const { state, ctx } = decision;
  if (ctx.rules.content.find(itemId)?.kind !== "item") return { code: "unknownItem" };
  if (direction === "sell" && !state.characters[characterId]?.equipment.includes(itemId)) return { code: "itemNotHeld" };
  const spent = wallet(decision, characterId);
  if (direction === "buy" && spent.gold < price) return { code: "insufficientGold" };
  const trade: TradeRecord = {
    id: `trade:${state.tradeCount + 1}`,
    characterId,
    npcId,
    itemId,
    direction,
    listedPrice: price,
    finalPrice: price,
    outcome: "completed",
    haggle: null,
  };
  settleTrade(decision, trade, spent.kind);
  return null;
}

function startHaggle(decision: Decision, command: Extract<ShopCommand, { kind: "hagglePrice" }>): Rejection | null {
  const { characterId, npcId, itemId, direction, listedPrice, skill } = command;
  const refusal = mayTrade(decision, characterId, npcId);
  if (refusal !== null) return refusal;
  const { state, ctx } = decision;
  if (ctx.rules.content.find(itemId)?.kind !== "item") return { code: "unknownItem" };
  if (direction === "sell" && !state.characters[characterId]?.equipment.includes(itemId)) return { code: "itemNotHeld" };
  if (!isSkill(skill) || !(haggleSkills as readonly string[]).includes(skill)) return { code: "invalidHaggleSkill" };
  if (state.hagglePending?.[characterId] !== undefined) return { code: "haggleAlreadyPending" };
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "notYourCharacter" };

  const test: CheckTest = { kind: "skill", skill };
  const dc = dcLadder.medium;
  // The same mechanical disadvantage every ability check carries at
  // Exhaustion 1+ (round-plan.ts's checks apply it too); nothing else about
  // the roll is up to the Planner or the Narrator here.
  const exhaustionPenalty = (state.heroStatus[characterId]?.exhaustion ?? 0) >= 1 ? 1 : 0;
  const haggle: PendingHaggle = {
    characterId,
    npcId,
    itemId,
    direction,
    listedPrice,
    test,
    dc,
    spec: { mode: resolveRollMode(0, exhaustionPenalty), modifier: checkModifier(sheet, test), bonusDice: [] },
    rollId: `haggle:${characterId}:${state.tradeCount + 1}`,
  };
  decision.emit({ kind: "haggleStarted", haggle });
  decision.request({ kind: "roll", rollId: haggle.rollId, spec: { kind: "d20Test", spec: haggle.spec } });
  return null;
}

// The roll worker saved a result for a pending haggle (decide.ts's recordRoll
// dispatcher tries this after combat and round-plan checks). A better roll
// buys a bigger discount (buying) or a bigger markup (selling), capped at
// 25%, scaling 2% per point the roll beats the DC by; a failed roll changes
// nothing — SRD leaves a failed negotiation's cost to the table, and this
// engine's default is "no worse than the listed price," the least punishing
// common convention. Even a success can still leave the hero short: haggling
// only lowers the price, it never lends them the difference.
export function recordHaggleRoll(decision: Decision, haggle: PendingHaggle, result: RollResult): Rejection | null {
  if (result.kind !== "d20Test" || !rollMatchesSpec(result.roll, haggle.spec)) return { code: "rollMismatch" };
  const { ctx } = decision;
  const naturalRule = ctx.rules.houseRules.option(naturalRollsOnChecks);
  const outcome = resolveD20Test("abilityCheck", result.roll.d20.natural, result.roll.total, haggle.dc, naturalRule);
  const moments = classifyRollMoments({ kind: "abilityCheck", roll: result.roll, target: haggle.dc, naturalRule });
  const margin = Math.max(0, result.roll.total - haggle.dc);
  const multiplier = outcome.success
    ? haggle.direction === "buy"
      ? Math.max(0.75, 1 - 0.02 * margin)
      : Math.min(1.25, 1 + 0.02 * margin)
    : 1;
  const finalPrice = Math.round(haggle.listedPrice * multiplier);

  const spent = wallet(decision, haggle.characterId);
  const affordable = haggle.direction !== "buy" || spent.gold >= finalPrice;
  const trade: TradeRecord = {
    id: `trade:${decision.state.tradeCount + 1}`,
    characterId: haggle.characterId,
    npcId: haggle.npcId,
    itemId: haggle.itemId,
    direction: haggle.direction,
    listedPrice: haggle.listedPrice,
    finalPrice,
    outcome: affordable ? "completed" : "cannotAfford",
    haggle: { test: haggle.test, dc: haggle.dc, total: result.roll.total, success: outcome.success, moments },
  };
  settleTrade(decision, trade, spent.kind);
  return null;
}

// Applies a settled trade's gold and item movement (skipped for a haggle
// that succeeded but still came up short) and queues the Narrator's line.
function settleTrade(decision: Decision, trade: TradeRecord, walletKind: "pool" | "hero"): void {
  decision.emit({ kind: "tradeSettled", trade, wallet: walletKind });
  decision.request({ kind: "narrateTrade", tradeId: trade.id });
}

function recordTradeNarration(decision: Decision, tradeId: string, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyNarration" };
  if (state.trades[tradeId] === undefined) return { code: "staleNarration" };
  decision.emit({ kind: "tradeNarrated", tradeId, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "tradeNarrated", tradeId } });
  return null;
}
