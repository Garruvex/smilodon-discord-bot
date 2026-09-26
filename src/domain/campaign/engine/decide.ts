import type { CampaignCommand } from "../commands/campaign-command.js";
import { assertNever } from "../core/assert-never.js";
import type { RollId } from "../core/ids.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { CampaignState } from "../state/campaign-state.js";
import { recordCheckRoll, requestRoll, rollTimerExpired } from "./checks.js";
import { handleCombatCommand, recordCombatNarration, recordCombatRoll } from "./combat/combat-flow.js";
import { handleInventoryCommand } from "./inventory.js";
import { takeRest } from "./rest.js";
import { Decision, type DecideResult, type EngineContext } from "./decision.js";
import { recordLedgerFact, recordNarration, reportPlannerFailure, retryPlan } from "./dm.js";
import { continueCampaign, joinHero, markAway, markReturned } from "./members.js";
import type { Rejection } from "./rejection.js";
import { applyRoundPlan } from "./round-plan.js";
import { closeRoundByOrganizer, openRound, pass, roundTimerExpired, submitAction } from "./rounds.js";

// Pure. Validates a command against the state and rules and returns the
// events and requests it causes, or a typed rejection. A rejected command
// changes nothing, even if a step emitted events before refusing.
export function decide(state: CampaignState, command: CampaignCommand, ctx: EngineContext): DecideResult {
  const decision = new Decision(state, ctx);
  const rejection = handle(decision, command);
  return rejection === null ? decision.result() : { kind: "rejected", rejection };
}

function handle(decision: Decision, command: CampaignCommand): Rejection | null {
  switch (command.kind) {
    case "openRound":
      return openRound(decision);
    case "submitAction":
      return submitAction(decision, command.characterId, command.text);
    case "pass":
      return pass(decision, command.characterId);
    case "closeRound":
      return closeRoundByOrganizer(decision);
    case "roundTimerExpired":
      return roundTimerExpired(decision, command.roundNumber);
    case "applyRoundPlan":
      return applyRoundPlan(decision, command.proposal);
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
    case "continue":
      return continueCampaign(decision);
    case "reportPlannerFailure":
      return reportPlannerFailure(decision, command.roundNumber, command.problems);
    case "retryPlan":
      return retryPlan(decision);
    case "recordNarration":
      return recordNarration(decision, command.roundNumber, command.text);
    case "recordCombatNarration":
      return recordCombatNarration(decision, command.encounterId, command.round, command.text);
    case "recordLedgerFact":
      return recordLedgerFact(decision, command);
    case "takeRest":
      return takeRest(decision, command.rest);
    case "offerItem":
    case "respondToOffer":
    case "cancelOffer":
    case "stashItem":
    case "takeFromStash":
      return handleInventoryCommand(decision, command);
    case "joinHero":
      return joinHero(decision, command.sheet);
    case "startEncounter":
    case "combatMove":
    case "combatEngage":
    case "combatWithdraw":
    case "combatAttack":
    case "combatCast":
    case "combatUseFeature":
    case "combatDisengage":
    case "combatDash":
    case "combatDodge":
    case "endTurn":
    case "turnTimerExpired":
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
  return recordCombatRoll(decision, rollId, result);
}
