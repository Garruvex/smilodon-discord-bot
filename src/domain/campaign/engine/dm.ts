import type { CampaignCommand, RecordLedgerFactCommand } from "../commands/campaign-command.js";
import { isLedgerEntityId } from "../ledger/ledger.js";
import { beginEncounter } from "./combat/combat-flow.js";
import type { Decision } from "./decision.js";
import { maxNarrationLength } from "./narration-limits.js";
import type { Rejection } from "./rejection.js";
import { finishReadyCheck, openRound } from "./rounds.js";

export const maxLedgerFactLength = 300;
export const maxSummaryLength = 1_500;
// A summary is asked for at a scene change, or after this many narrated rounds without one.
export const chronicleEveryRounds = 6;

// Numbers such as hit points, slots and gold change all the time; a summary
// that states them would go stale and contradict the live state.
const vitalNumbers = /\b\d+\s*(?:hp|hit points?|hit dice|slots?|gp|gold|coins?)\b|\b(?:hp|gold|slots?)\s*[:=]?\s*\d+|\d+\s*(?:點生命|生命值?|金幣|法術位)/i;

export function latestSummaryRound(summaries: readonly { readonly throughRound: number; readonly visibility: string }[] | undefined, visibility: "public" | "private"): number {
  return (summaries ?? []).filter((summary) => summary.visibility === visibility).reduce((latest, summary) => Math.max(latest, summary.throughRound), 0);
}

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

// The game has started: ask the Narrator for the opening scene. Nothing else
// happens until it is told, so no round timer runs while the table reads. A
// game that already has a round (or an opening) is left as it is, which also
// makes a restart's second attempt harmless.
export function beginAdventure(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  if (state.opening !== undefined || state.lastRoundNumber > 0 || state.round !== null) return null;
  decision.emit({ kind: "adventureBegan" });
  decision.request({ kind: "narrateOpening" });
  return null;
}

// Saves the opening. The first round opens once every present player has
// pressed Ready (or the organizer starts it), so nobody misses the scene.
export function recordOpening(decision: Decision, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxNarrationLength) return { code: "emptyNarration" };
  if (state.opening !== "pending") return { code: "staleNarration" };
  decision.emit({ kind: "openingRecorded", text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "opening" } });
  if (decision.state.status === "active") finishReadyCheck(decision);
  return null;
}

// A present player is ready for round 1.
export function markReady(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user") return { code: "notMember" };
  const member = state.members[ctx.actor.userId];
  if (member === undefined) return { code: "notMember" };
  if (member.availability === "away") return { code: "memberAway" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.opening !== "waiting") return { code: "notAwaitingReady" };
  if (!(state.openingReady ?? []).includes(member.userId)) decision.emit({ kind: "memberReadied", userId: member.userId });
  finishReadyCheck(decision);
  return null;
}

// The organizer does not wait for the rest of the table.
export function beginPlay(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.opening !== "waiting") return { code: "notAwaitingReady" };
  decision.emit({ kind: "tableReady" });
  openRound(decision, { skipActorCheck: true });
  return null;
}

// Saves the Narrator's text for a resolved round, then starts the fight the
// round queued, or opens the next round, if anyone is present. Narration
// that arrives while the table is waiting is still kept; the next step waits
// for continue.
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
  // A chapter closed, or enough rounds piled up: the Chronicler condenses them in the background.
  if (state.sceneChangedRound === roundNumber || roundNumber - latestSummaryRound(state.summaries, "public") >= chronicleEveryRounds) {
    decision.request({ kind: "chronicle", throughRound: roundNumber });
  }
  if (decision.state.status !== "active") return null;
  const pending = decision.state.pendingEncounter;
  if (pending !== null) {
    beginEncounter(decision, pending);
    return null;
  }
  return openRound(decision);
}

// Keeps the Chronicler's summary of the rounds through `throughRound`. A late
// one, made before newer rounds were summarized, is refused rather than
// overwriting what is already there; a summary stating hit points, slots or
// gold is refused because those come from live state only.
export function recordSummary(decision: Decision, command: Extract<CampaignCommand, { kind: "recordSummary" }>): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const text = command.text.trim();
  if (text.length === 0 || text.length > maxSummaryLength) return { code: "invalidSummary", problem: "text" };
  if (vitalNumbers.test(text)) return { code: "invalidSummary", problem: "numbers" };
  if (!Number.isInteger(command.throughRound) || command.throughRound < 1 || command.throughRound > state.lastNarratedRound) return { code: "staleSummary" };
  if (command.throughRound <= latestSummaryRound(state.summaries, command.visibility)) return { code: "staleSummary" };
  decision.emit({ kind: "summaryRecorded", throughRound: command.throughRound, visibility: command.visibility, text });
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
