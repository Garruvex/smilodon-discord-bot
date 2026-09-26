import type { CheckId, Instant, UserId } from "../core/ids.js";
import { presentMembers } from "../state/campaign-state.js";
import { deadlineAfter, type Decision } from "./decision.js";
import { rollTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { resumeCombat } from "./combat.js";
import { closeIfEveryoneResponded, enterWaiting, finishRoundIfResolved, openRound } from "./rounds.js";

// A player marks themselves away, or the organizer marks them. An open
// window's unanswered slot is excused rather than counted as a miss; a
// submitted action stands.
export function markAway(decision: Decision, userId: UserId): Rejection | null {
  const refusal = checkSelfOrOrganizer(decision, userId);
  if (refusal !== null) return refusal;
  const member = decision.state.members[userId];
  if (member === undefined) return { code: "notMember" };
  if (member.availability === "away") return null;

  const reason = decision.ctx.actor.kind === "user" && decision.ctx.actor.userId === userId ? "self" : "organizer";
  decision.emit({ kind: "memberMarkedAway", userId, reason });
  const round = decision.state.round;
  const characterId = member.characterId;
  if (
    round?.status === "collecting" &&
    characterId !== null &&
    round.participants.includes(characterId) &&
    round.submissions[characterId] === undefined
  ) {
    decision.emit({ kind: "slotExcused", roundNumber: round.number, characterId });
    closeIfEveryoneResponded(decision);
  }
  if (decision.state.status === "active" && presentMembers(decision.state).length === 0) enterWaiting(decision);
  return null;
}

// "I'm back": the hero joins at the next round boundary. It does not resume
// a waiting campaign by itself; continue does that explicitly.
export function markReturned(decision: Decision, userId: UserId): Rejection | null {
  const refusal = checkSelfOrOrganizer(decision, userId);
  if (refusal !== null) return refusal;
  const member = decision.state.members[userId];
  if (member === undefined) return { code: "notMember" };
  if (member.availability === "present") return null;
  decision.emit({ kind: "memberReturned", userId });
  return null;
}

// Resumes a campaign that was waiting for players, picking up held work:
// planning, pending rolls (with fresh deadlines), or the next round.
export function continueCampaign(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user") return { code: "notMember" };
  const member = state.members[ctx.actor.userId];
  if (member === undefined && ctx.actor.userId !== state.organizerId) return { code: "notMember" };
  if (member?.availability === "away") return { code: "memberAway" };
  if (state.status !== "waitingForPlayers") return { code: "campaignNotWaiting" };
  if (presentMembers(state).length === 0) return { code: "nobodyPresent" };

  const checkDeadlines: Record<CheckId, Instant | null> = {};
  for (const check of Object.values(state.checks)) {
    if (check.status === "pending") checkDeadlines[check.id] = deadlineAfter(ctx.now, state.pacing.rollSeconds);
  }
  decision.emit({ kind: "resumed", checkDeadlines });
  for (const [checkId, dueAt] of Object.entries(checkDeadlines)) {
    if (dueAt !== null) {
      decision.request({ kind: "startTimer", timer: { kind: "roll", timerId: rollTimerId(checkId), dueAt, checkId } });
    }
  }

  const encounter = decision.state.encounter;
  if (encounter !== null && encounter.status !== "ended") {
    resumeCombat(decision);
    return null;
  }
  const round = decision.state.round;
  if (round === null) return openRound(decision);
  if (round.status === "planning") decision.request({ kind: "plan", roundNumber: round.number });
  if (round.status === "resolving") finishRoundIfResolved(decision);
  return null;
}

function checkSelfOrOrganizer(decision: Decision, userId: UserId): Rejection | null {
  const { actor } = decision.ctx;
  if (actor.kind === "system") return null;
  if (actor.userId === userId || actor.userId === decision.state.organizerId) return null;
  return { code: "notOrganizer" };
}
