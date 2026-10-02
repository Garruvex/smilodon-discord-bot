// The effects a story beat can have, applied by the engine: a round's planned effects after its checks, and a fight's triggers and
// victory. One vocabulary for both, so an adventure is data and never code.
import type { EncounterSpec, PartyEffect } from "../commands/campaign-command.js";
import { assertNever } from "../core/assert-never.js";
import { lootGold } from "../rules/house-rules.js";
import { isFallen, type CampaignState, type MoveReason } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";


// One fired effect. A fight can be queued only once at a time, and one that
// was already fought is not queued again (a filled clock may name it).
export function applyStoryEffect(decision: Decision, roundNumber: number, effect: PartyEffect, moveReason?: MoveReason): void {
  const { state } = decision;
  switch (effect.kind) {
    case "transitionScene":
      decision.emit({ kind: "sceneTransitioned", roundNumber, sceneId: effect.sceneId, ...(moveReason === undefined ? {} : { reason: moveReason }) });
      decision.request({ kind: "deliver", delivery: { kind: "sceneArrival", sceneId: effect.sceneId, roundNumber } });
      decision.request({ kind: "sceneImage", sceneId: effect.sceneId, roundNumber, snapshot: decision.pictureSnapshot() });
      return;
    case "revealClue":
      if (!state.clues.some((clue) => clue.id === effect.clueId)) decision.emit({ kind: "clueRevealed", roundNumber, clueId: effect.clueId, text: effect.text });
      return;
    case "advanceClock": {
      const before = state.clocks[effect.clockId]?.filled ?? 0;
      const filled = Math.min(effect.segments, before + effect.by);
      if (filled === before) return;
      decision.emit({ kind: "clockAdvanced", roundNumber, clockId: effect.clockId, segments: effect.segments, filled });
      if (filled === effect.segments && effect.onFull !== null) queueEncounter(decision, roundNumber, effect.onFull);
      return;
    }
    case "startEncounter":
      queueEncounter(decision, roundNumber, effect.encounter);
      return;
    case "setFlag":
      if (state.flags?.[effect.flag] !== effect.value) decision.emit({ kind: "flagSet", roundNumber, flag: effect.flag, value: effect.value });
      return;
    case "grantReward": {
      const key = `reward:${effect.rewardId}`;
      if (state.flags?.[key] !== undefined) return;
      decision.emit({ kind: "flagSet", roundNumber, flag: key, value: 1 });
      const split = decision.ctx.rules.houseRules.option(lootGold) === "split" ? rewardShares(state, effect.gold) : undefined;
      decision.emit({ kind: "lootFound", encounterId: effect.rewardId, items: effect.items, gold: effect.gold, ...(split === undefined ? {} : { split }) });
      decision.request({ kind: "deliver", delivery: { kind: "rewardFound", rewardId: effect.rewardId } });
      return;
    }
    case "notice": {
      const key = `notice:${effect.noticeId}`;
      if (state.flags?.[key] !== undefined) return;
      decision.emit({ kind: "flagSet", roundNumber, flag: key, value: 1 });
      decision.request({ kind: "deliver", delivery: { kind: "storyNotice", text: effect.text } });
      return;
    }
    case "grantKeepsake":
      if (state.keepsakes?.[effect.keepsake.id] !== undefined) return;
      decision.emit({ kind: "keepsakeGained", roundNumber, keepsake: effect.keepsake });
      decision.request({ kind: "deliver", delivery: { kind: "keepsakeGained", keepsakeId: effect.keepsake.id } });
      return;
    case "advanceTime":
      decision.changeWorld(roundNumber, { kind: "advance", steps: effect.steps }, "story");
      return;
    case "setWeather":
      decision.changeWorld(roundNumber, { kind: "weather", weather: effect.weather }, "story");
      return;
    case "spendGold": {
      const split = decision.ctx.rules.houseRules.option(lootGold) === "split";
      const available = split ? (state.heroGold?.[effect.characterId] ?? 0) : state.gold;
      if (available < effect.amount) return;
      decision.emit({ kind: "goldSpent", roundNumber, characterId: effect.characterId, amount: effect.amount, wallet: split ? "hero" : "pool" });
      decision.request({ kind: "deliver", delivery: { kind: "paymentMade", characterId: effect.characterId, amount: effect.amount } });
      return;
    }
    default:
      assertNever(effect);
  }
}

// An even share for each hero still standing, the remainder to the first (the same split a fight's gold gets).
function rewardShares(state: CampaignState, gold: number): Readonly<Record<string, number>> | undefined {
  const standing = Object.values(state.characters).filter((sheet) => !isFallen(state, sheet.id)).map((sheet) => sheet.id);
  if (gold <= 0 || standing.length === 0) return undefined;
  const each = Math.floor(gold / standing.length);
  return Object.fromEntries(standing.map((characterId, index) => [characterId, each + (index === 0 ? gold - each * standing.length : 0)]));
}

function queueEncounter(decision: Decision, roundNumber: number, encounter: EncounterSpec): void {
  const { state } = decision;
  if (state.pendingEncounter !== null || state.encounterHistory.includes(encounter.id)) return;
  decision.emit({ kind: "encounterQueued", roundNumber, encounter });
}
