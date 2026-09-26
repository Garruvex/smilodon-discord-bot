import type { CharacterId } from "../core/ids.js";
import type { RoundCloseReason } from "../events/campaign-event.js";
import { presentMembers, type CampaignState, type RoundState } from "../state/campaign-state.js";
import { deadlineAfter, type Decision } from "./decision.js";
import { rollTimerId, roundTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";

export const maxActionLength = 500;

export function openRound(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user") {
    const userId = ctx.actor.userId;
    const member = state.members[userId];
    if (member === undefined && userId !== state.organizerId) return { code: "notMember" };
    if (member !== undefined && member.availability === "away") return { code: "memberAway" };
  }
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round !== null) return { code: "roundAlreadyOpen" };

  const participants = participantsFor(state);
  if (participants.length === 0) {
    if (ctx.actor.kind === "user") return { code: "nobodyPresent" };
    enterWaiting(decision);
    return null;
  }
  const roundNumber = state.lastRoundNumber + 1;
  const closesAt = deadlineAfter(ctx.now, state.pacing.roundSeconds);
  decision.emit({ kind: "roundOpened", roundNumber, participants, closesAt });
  if (closesAt !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "roundWindow", timerId: roundTimerId(roundNumber), dueAt: closesAt, roundNumber },
    });
  }
  return null;
}

export function submitAction(decision: Decision, characterId: CharacterId, text: string): Rejection | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyAction" };
  if (trimmed.length > maxActionLength) return { code: "actionTooLong", maxLength: maxActionLength };
  const round = roundAcceptingResponse(decision, characterId);
  if ("code" in round) return round;
  const previous = round.submissions[characterId];
  const revision = previous?.kind === "action" ? previous.revision + 1 : 1;
  decision.emit({ kind: "actionSubmitted", roundNumber: round.number, characterId, text: trimmed, revision });
  closeIfEveryoneResponded(decision);
  return null;
}

export function pass(decision: Decision, characterId: CharacterId): Rejection | null {
  const round = roundAcceptingResponse(decision, characterId);
  if ("code" in round) return round;
  decision.emit({ kind: "passSubmitted", roundNumber: round.number, characterId });
  closeIfEveryoneResponded(decision);
  return null;
}

export function closeRoundByOrganizer(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round === null) return { code: "noOpenRound" };
  if (state.round.status !== "collecting") return { code: "roundNotCollecting" };
  closeRound(decision, "organizer");
  return null;
}

// A timer that fires after its round already moved on is not an error: the
// response and the expiry raced, and the response won.
export function roundTimerExpired(decision: Decision, roundNumber: number): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const { state } = decision;
  if (state.status !== "active" || state.round?.number !== roundNumber || state.round.status !== "collecting") {
    return null;
  }
  closeRound(decision, "timer");
  return null;
}

export function closeIfEveryoneResponded(decision: Decision): void {
  const round = decision.state.round;
  if (round?.status !== "collecting") return;
  if (round.participants.every((characterId) => round.submissions[characterId] !== undefined)) {
    closeRound(decision, "allResponded");
  }
}

function closeRound(decision: Decision, reason: RoundCloseReason): void {
  const round = decision.state.round;
  if (round === null) return;
  const missed = round.participants.filter((characterId) => round.submissions[characterId] === undefined);
  if (reason !== "timer" && round.closesAt !== null) {
    decision.request({ kind: "cancelTimer", timerId: roundTimerId(round.number) });
  }
  decision.emit({ kind: "roundClosed", roundNumber: round.number, reason, missed });

  const { awayAfterMisses } = decision.state.pacing;
  for (const member of Object.values(decision.state.members)) {
    if (member.availability === "present" && member.consecutiveMisses >= awayAfterMisses) {
      decision.emit({ kind: "memberMarkedAway", userId: member.userId, reason: "missedTimers" });
    }
  }

  const hasActions = Object.values(round.submissions).some((submission) => submission.kind === "action");
  if (!hasActions) {
    // Only passes and misses: a template status, no model call, and no
    // automatic next round.
    decision.emit({ kind: "roundResolved", roundNumber: round.number, quiet: true });
    decision.request({ kind: "deliver", delivery: { kind: "quietRound", roundNumber: round.number } });
  }
  if (presentMembers(decision.state).length === 0) {
    enterWaiting(decision);
    return;
  }
  if (hasActions) decision.request({ kind: "plan", roundNumber: round.number });
}

// Every check of the round is resolved: the round is done and the Narrator
// describes it. Held while waiting for players; continue finishes it.
export function finishRoundIfResolved(decision: Decision): void {
  const { state } = decision;
  const round = state.round;
  if (state.status !== "active" || round?.status !== "resolving") return;
  const checks = Object.values(state.checks).filter((check) => check.roundNumber === round.number);
  if (checks.some((check) => check.status !== "resolved")) return;
  decision.emit({ kind: "roundResolved", roundNumber: round.number, quiet: false });
  decision.request({ kind: "narrate", roundNumber: round.number });
}

// Nobody is present: suspend all timers and hold pending work until a
// returning player explicitly continues.
export function enterWaiting(decision: Decision): void {
  const { state } = decision;
  if (state.status === "waitingForPlayers") return;
  if (state.round?.status === "collecting" && state.round.closesAt !== null) {
    decision.request({ kind: "cancelTimer", timerId: roundTimerId(state.round.number) });
  }
  for (const check of Object.values(state.checks)) {
    if (check.status === "pending" && check.deadline !== null) {
      decision.request({ kind: "cancelTimer", timerId: rollTimerId(check.id) });
    }
  }
  decision.emit({ kind: "waitingForPlayers" });
  decision.request({ kind: "deliver", delivery: { kind: "waitingForPlayers" } });
}

// Present members' heroes, in the order members joined.
function participantsFor(state: CampaignState): readonly CharacterId[] {
  return presentMembers(state).flatMap((member) =>
    member.characterId !== null && state.characters[member.characterId] !== undefined ? [member.characterId] : [],
  );
}

// The round this character may respond in right now, or why they cannot.
function roundAcceptingResponse(decision: Decision, characterId: CharacterId): RoundState | Rejection {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user") return { code: "notYourCharacter" };
  const member = state.members[ctx.actor.userId];
  if (member === undefined) return { code: "notMember" };
  if (state.characters[characterId]?.ownerUserId !== member.userId) return { code: "notYourCharacter" };
  if (member.availability === "away") return { code: "memberAway" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round === null) return { code: "noOpenRound" };
  if (state.round.status !== "collecting") return { code: "roundNotCollecting" };
  if (!state.round.participants.includes(characterId)) return { code: "notParticipant" };
  return state.round;
}
