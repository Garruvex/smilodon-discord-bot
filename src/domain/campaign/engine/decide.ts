import type { CampaignCommand } from "../commands/campaign-command.js";
import { assertNever } from "../core/assert-never.js";
import type { RollId } from "../core/ids.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { CampaignState } from "../state/campaign-state.js";
import { recordCheckRoll, requestRoll, rollTimerExpired } from "./checks.js";
import { retryEncounter } from "./combat/combat-retry.js";
import { canHandOver, refreshGear, startHandOver } from "./combat/combat-gear.js";
import { encounterProblems, handleCombatCommand, recordCombatNarration, recordCombatRoll } from "./combat/combat-flow.js";
import { handleInventoryCommand } from "./inventory.js";
import { takeRest } from "./rest.js";
import { handleDialogueCommand, recordPressRoll } from "./dialogue.js";
import { handleShopCommand, recordHaggleRoll } from "./shop.js";
import { recordEnvironmentalDamageRoll } from "./environmental-damage.js";
import { handleTravelCommand, recordHazardRoll } from "./travel.js";
import { handleHealingMagicCommand, recordHealingRoll } from "./healing-magic.js";
import { handleRevivalMagicCommand } from "./revival-magic.js";
import { chooseWarlockOptions } from "./warlock-choices.js";
import { handleCompanionMagicCommand } from "./companion-magic.js";
import { handleUtilityMagicCommand } from "./utility-magic.js";
import { Decision, type DecideResult, type EngineContext } from "./decision.js";
import { beginAdventure, beginPlay, compactSceneNotes, correctWorld, illustrateMoment, markReady, redoPicture, recordLedgerFact, recordNarration, recordOpening, recordSummary, regenerateNarration, replaceNarration, reportPlannerFailure, retryPlan, reviewSceneNotes } from "./dm.js";
import { raisePartyLevel } from "./level-up.js";
import { chooseAsi, chooseClassLevel, chooseFightingStyle, continueCampaign, grantProxy, joinHero, markAway, markReturned, revokeProxy } from "./members.js";
import { isSkill } from "../character/character-sheet.js";
import { pauseCampaign } from "./pause.js";
import { remind } from "./reminders.js";
import { speak } from "./speech.js";
import type { Rejection } from "./rejection.js";
import { applyRoundPlan } from "./round-plan.js";
import { objectToMove, proposeMoveByPlayer, settleMoveByOrganizer, withdrawObjection } from "./scene-move.js";
import { closeRoundByOrganizer, openRound, pass, roundTimerExpired, submitAction } from "./rounds.js";

// Pure. Validates a command against the state and rules and returns the
// events and requests it causes, or a typed rejection. A rejected command
// changes nothing, even if a step emitted events before refusing.
export function decide(state: CampaignState, command: CampaignCommand, ctx: EngineContext): DecideResult {
  // Pause is a campaign-wide stop, not just a frozen timer. Keep every player
  // action behind the same gate; otherwise commands without their own state
  // check (such as a free cantrip) can still change the game while paused.
  if (state.pausedBy !== null && ctx.actor.kind === "user" && command.kind !== "continue" && command.kind !== "pauseCampaign") {
    return { kind: "rejected", rejection: { code: "campaignPaused" } };
  }
  const decision = new Decision(state, ctx);
  const rejection = handle(decision, command);
  return rejection === null ? decision.result() : { kind: "rejected", rejection };
}

function handle(decision: Decision, command: CampaignCommand): Rejection | null {
  switch (command.kind) {
    case "openRound":
      return openRound(decision);
    case "submitAction":
      return submitAction(decision, command.characterId, command.text, command.roundNumber);
    case "pass":
      return pass(decision, command.characterId);
    case "closeRound":
      return closeRoundByOrganizer(decision);
    case "roundTimerExpired":
      return roundTimerExpired(decision, command.roundNumber);
    case "timerReminder":
      return remind(decision, command.target);
    case "applyRoundPlan":
      return applyRoundPlan(decision, command.proposal, encounterProblems);
    case "requestRoll":
      return requestRoll(decision, command.checkId);
    case "rollTimerExpired":
      return rollTimerExpired(decision, command.checkId);
    case "recordRoll":
      return recordRoll(decision, command.rollId, command.result);
    case "markAway":
      return markAway(decision, command.userId);
    case "markReturned":
      return markReturned(decision, command.userId);
    case "grantProxy":
      return grantProxy(decision, command.proxyUserId);
    case "revokeProxy":
      return revokeProxy(decision);
    case "proposeMove":
      return proposeMoveByPlayer(decision, command.sceneId, command.effects);
    case "objectToMove":
      return objectToMove(decision);
    case "withdrawObjection":
      return withdrawObjection(decision);
    case "settleMove":
      return settleMoveByOrganizer(decision, command.outcome);
    case "continue":
      return continueCampaign(decision);
    case "pauseCampaign":
      return pauseCampaign(decision, command.reason);
    case "speak":
      return speak(decision, command.characterId, command.text);
    case "reportPlannerFailure":
      return reportPlannerFailure(decision, command.roundNumber, command.problems);
    case "retryPlan":
      return retryPlan(decision);
    case "recordNarration":
      return recordNarration(decision, command.roundNumber, command.text, command.note);
    case "reviewSceneNotes":
      return reviewSceneNotes(decision, command);
    case "compactSceneNotes":
      return compactSceneNotes(decision, command);
    case "beginAdventure":
      return beginAdventure(decision);
    case "recordOpening":
      return recordOpening(decision, command.text);
    case "ready":
      return markReady(decision);
    case "beginPlay":
      return beginPlay(decision);
    case "recordCombatNarration": {
      const rejection = recordCombatNarration(decision, command.encounterId, command.round, command.text);
      if (rejection !== null) return rejection;
      // The closing narration of a fight opens the next exploration round.
      const { encounter } = decision.state;
      if (encounter?.status === "ended" && command.round === encounter.round && decision.state.status === "active" && decision.state.round === null) return openRound(decision);
      return null;
    }
    case "recordLedgerFact":
      return recordLedgerFact(decision, command);
    case "recordSummary":
      return recordSummary(decision, command);
    case "redoPicture":
      return redoPicture(decision, command.subject);
    case "illustrateMoment":
      return illustrateMoment(decision, command.roundNumber);
    case "regenerateNarration":
      return regenerateNarration(decision, command.roundNumber);
    case "replaceNarration":
      return replaceNarration(decision, command.roundNumber, command.text);
    case "setWorld":
      return correctWorld(decision, command);
    case "takeRest":
      return takeRest(decision, command.rest, command.story ?? []);
    case "offerItem":
    case "respondToOffer":
    case "cancelOffer":
    case "stashItem":
    case "takeFromStash":
    case "useItem":
    case "wearItem":
    case "removeItem":
      return handleInventoryCommand(decision, command, { startHandOver, canHandOver, refreshGear });
    case "retryEncounter":
      return retryEncounter(decision);
    case "joinHero":
      return joinHero(decision, command.sheet, command.entrance);
    case "buyItem":
    case "sellItem":
    case "hagglePrice":
    case "recordTradeNarration":
      return handleShopCommand(decision, command);
    case "askNpc":
    case "pressNpc":
    case "recordDialogueNarration":
      return handleDialogueCommand(decision, command);
    case "castRitualSpell":
    case "recordUtilityCastNarration":
      return handleUtilityMagicCommand(decision, command);
    case "castReviveSpell":
      return handleRevivalMagicCommand(decision, command);
    case "summonCompanion":
    case "dismissCompanion":
      return handleCompanionMagicCommand(decision, command);
    case "castHealingSpell":
      return handleHealingMagicCommand(decision, command);
    case "faceHazard":
    case "recordHazardNarration":
    case "takeEnvironmentalDamage":
      return handleTravelCommand(decision, command);
    case "chooseClassLevel": {
      const skillChoice = command.skillChoice !== undefined && isSkill(command.skillChoice) ? command.skillChoice : undefined;
      return chooseClassLevel(decision, command.characterId, command.buildClass, skillChoice);
    }
    case "chooseAsi":
      return chooseAsi(decision, command.characterId, command.allocation);
    case "chooseWarlockOptions":
      return chooseWarlockOptions(decision, command.characterId, command.invocations, command.pactBoon);
    case "chooseFightingStyle":
      return chooseFightingStyle(decision, command.characterId, command.styleId);
    case "raiseLevel":
      return raisePartyLevel(decision, command.level);
    case "startEncounter":
    case "combatMove":
    case "combatEngage":
    case "combatWithdraw":
    case "combatAttack":
    case "combatCast":
    case "combatUseFeature":
    case "combatUseItem":
    case "combatShield":
    case "combatDisengage":
    case "combatDash":
    case "combatDodge":
    case "combatWildShape":
    case "endTurn":
    case "combatReact":
    case "combatOpportunityAttack":
    case "combatSmite":
    case "turnTimerExpired":
    case "reactionTimerExpired":
    case "smiteTimerExpired":
    case "opportunityAttackTimerExpired":
      return handleCombatCommand(decision, command);
    default:
      return assertNever(command);
  }
}

// The roll worker saved a result: route it to the check or combat stage
// waiting for it. Re-recording a resolved check is a no-op.
function recordRoll(decision: Decision, rollId: RollId, result: RollResult): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const check = Object.values(decision.state.checks).find((candidate) => candidate.rollId === rollId);
  if (check !== undefined) return recordCheckRoll(decision, check, result);
  const haggle = Object.values(decision.state.hagglePending ?? {}).find((candidate) => candidate.rollId === rollId);
  if (haggle !== undefined) return recordHaggleRoll(decision, haggle, result);
  const press = Object.values(decision.state.pressPending ?? {}).find((candidate) => candidate.rollId === rollId);
  if (press !== undefined) return recordPressRoll(decision, press, result);
  const hazard = Object.values(decision.state.hazardPending ?? {}).find((candidate) => candidate.rollId === rollId);
  if (hazard !== undefined) return recordHazardRoll(decision, hazard, result);
  const damage = Object.values(decision.state.damagePending ?? {}).find((candidate) => candidate.rollId === rollId);
  if (damage !== undefined) return recordEnvironmentalDamageRoll(decision, damage, result);
  const healing = Object.values(decision.state.healingPending ?? {}).find((candidate) => candidate.rollId === rollId);
  if (healing !== undefined) return recordHealingRoll(decision, healing, result);
  return recordCombatRoll(decision, rollId, result);
}
