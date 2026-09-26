import type { CampaignCommand } from "../commands/campaign-command.js";
import { assertNever } from "../core/assert-never.js";
import type { CampaignState } from "../state/campaign-state.js";
import { recordRoll, requestRoll, rollTimerExpired } from "./checks.js";
import { Decision, type DecideResult, type EngineContext } from "./decision.js";
import { recordLedgerFact, recordNarration, reportPlannerFailure, retryPlan } from "./dm.js";
import { continueCampaign, markAway, markReturned } from "./members.js";
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
      return recordRoll(decision, command.rollId, command.roll);
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
    case "recordLedgerFact":
      return recordLedgerFact(decision, command);
    default:
      return assertNever(command);
  }
}
