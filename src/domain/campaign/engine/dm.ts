import type { RecordLedgerFactCommand } from "../commands/campaign-command.js";
import { isLedgerEntityId } from "../ledger/ledger.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";
import { openRound } from "./rounds.js";

export const maxNarrationLength = 4000;
export const maxLedgerFactLength = 300;

// The Planner failed validation twice: hold the round with a neutral line
// and tell the organizer. Submissions are kept for a retry.
export function reportPlannerFailure(decision: Decision, roundNumber: number, problems: readonly string[]): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const round = decision.state.round;
  if (round?.status !== "planning" || round.number !== roundNumber) return { code: "notPlanning" };
  decision.emit({ kind: "plannerFailed", roundNumber, problems });
  decision.request({ kind: "deliver", delivery: { kind: "dmHolding", roundNumber } });
  decision.request({ kind: "deliver", delivery: { kind: "organizerNotice", notice: "plannerFailed", roundNumber } });
  return null;
}

export function retryPlan(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round?.status !== "planning") return { code: "notPlanning" };
  decision.emit({ kind: "planRetryRequested", roundNumber: state.round.number });
  decision.request({ kind: "plan", roundNumber: state.round.number });
  return null;
}

// Saves the Narrator's text for a resolved round, then opens the next round
// if anyone is present. Narration that arrives while the table is waiting is
// still kept; the next round waits for continue.
export function recordNarration(decision: Decision, roundNumber: number, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxNarrationLength) return { code: "emptyNarration" };
  if (state.round !== null || state.lastRoundNumber !== roundNumber || state.lastNarratedRound >= roundNumber) {
    return { code: "staleNarration" };
  }
  decision.emit({ kind: "narrationRecorded", roundNumber, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "narration", roundNumber } });
  if (decision.state.status === "active") return openRound(decision);
  return null;
}

// Adds a fact to an entity's ledger entry. The first recorded name is the
// canonical spelling; a later fact under a different name is refused so the
// DM cannot drift names.
export function recordLedgerFact(decision: Decision, command: RecordLedgerFactCommand): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  if (!isLedgerEntityId(command.entityId)) return { code: "invalidLedgerFact", problem: "entityId" };
  const fact = command.fact.trim();
  const canonicalName = command.canonicalName.trim();
  if (fact.length === 0 || fact.length > maxLedgerFactLength) return { code: "invalidLedgerFact", problem: "fact" };
  if (canonicalName.length === 0) return { code: "invalidLedgerFact", problem: "canonicalName" };
  const existing = decision.state.ledger[command.entityId];
  if (existing !== undefined && existing.canonicalName !== canonicalName) {
    return { code: "canonicalNameLocked", canonicalName: existing.canonicalName };
  }
  decision.emit({ kind: "ledgerFactRecorded", entityId: command.entityId, canonicalName, fact, visibility: command.visibility });
  return null;
}
