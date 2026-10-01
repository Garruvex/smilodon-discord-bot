import type { CharacterId } from "../core/ids.js";
import type { RoundCloseReason } from "../events/campaign-event.js";
import { isFallen, presentMembers, type CampaignState, type RoundState } from "../state/campaign-state.js";
import { deadlineAfter, type Decision } from "./decision.js";
import { takeEnvironmentalDamage } from "./environmental-damage.js";
import { rollTimerId, roundTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { scheduleReminder } from "./reminders.js";
import { firedEffects } from "./round-plan.js";
import { deferredMove, proposeMove, settleDueMove } from "./scene-move.js";

export const maxActionLength = 500;

export function openRound(decision: Decision, options: { readonly skipActorCheck?: boolean } = {}): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && options.skipActorCheck !== true) {
    const userId = ctx.actor.userId;
    const member = state.members[userId];
    if (member === undefined && userId !== state.organizerId) return { code: "notMember" };
    if (member !== undefined && member.availability === "away") return { code: "memberAway" };
  }
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (state.round !== null) return { code: "roundAlreadyOpen" };

  // The opening is still being told, or the table is getting ready: the first
  // round opens when everyone is.
  if (state.opening === "pending" || state.opening === "waiting") return null;

  const participants = participantsFor(state);
  if (participants.length === 0) {
    if (ctx.actor.kind === "user") return { code: "nobodyPresent" };
    enterWaiting(decision);
    return null;
  }
  beginRound(decision, participants);
  return null;
}

function beginRound(decision: Decision, participants: readonly CharacterId[]): void {
  const roundNumber = decision.state.lastRoundNumber + 1;
  const closesAt = deadlineAfter(decision.ctx.now, decision.state.pacing.roundSeconds);
  decision.emit({ kind: "roundOpened", roundNumber, participants, closesAt });
  if (closesAt !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "roundWindow", timerId: roundTimerId(roundNumber), dueAt: closesAt, roundNumber },
    });
    scheduleReminder(decision, { kind: "round", roundNumber, closesAt });
  }
}

// Every present player is ready: the first round opens. Also checked when a
// player goes away, since the rest may already all be ready.
export function finishReadyCheck(decision: Decision): void {
  const { state } = decision;
  if (state.opening !== "waiting" || state.status !== "active") return;
  const ready = state.openingReady ?? [];
  if (!presentMembers(state).every((member) => ready.includes(member.userId))) return;
  decision.emit({ kind: "tableReady" });
  openRound(decision, { skipActorCheck: true });
}

export function submitAction(decision: Decision, characterId: CharacterId, text: string, forRound?: number): Rejection | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyAction" };
  if (trimmed.length > maxActionLength) return { code: "actionTooLong", maxLength: maxActionLength };
  const round = roundAcceptingResponse(decision, characterId);
  if ("code" in round) return round;
  // A form opened in an earlier round must not land in this one.
  if (forRound !== undefined && forRound !== round.number) return { code: "staleRound" };
  const previous = round.submissions[characterId];
  const revision = previous?.kind === "action" ? previous.revision + 1 : 1;
  decision.emit({ kind: "actionSubmitted", roundNumber: round.number, characterId, text: trimmed, revision });
  decision.request({ kind: "deliver", delivery: { kind: "actionIntent", roundNumber: round.number, characterId, revision } });
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
  settleDueMove(decision, round.number);

  const { awayAfterMisses } = decision.state.pacing;
  for (const member of Object.values(decision.state.members)) {
    if (member.availability === "present" && member.consecutiveMisses >= awayAfterMisses) {
      decision.emit({ kind: "memberMarkedAway", userId: member.userId, reason: "missedTimers" });
    }
  }

  const hasActions = Object.values(round.submissions).some((submission) => submission.kind === "action");
  if (!hasActions) {
    // Only passes and misses: a template status and no model call. The next
    // round opens straight away while someone is present, so the table is
    // never left without a panel to act on; missed rounds mark players away,
    // which is what stops a table nobody is at.
    decision.emit({ kind: "roundResolved", roundNumber: round.number, quiet: true });
    decision.request({ kind: "deliver", delivery: { kind: "quietRound", roundNumber: round.number } });
    const next = participantsFor(decision.state);
    if (next.length > 0 && decision.state.pausedBy === null) beginRound(decision, next);
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
  // Scene first, so the Narrator describes the round in the scene it leads to.
  const fired = [...firedEffects(state, round)].sort((a, b) => effectOrder[a.effect.kind] - effectOrder[b.effect.kind]);
  // A move the story does not force waits for the table; everything else happens now.
  const held = deferredMove(fired);
  for (const { effect } of fired.filter((candidate) => !held.includes(candidate))) {
    // Harm to a hero is an Exploration rule (the dice decide); a hero already down or already hurt this moment is spared.
    if (effect.kind === "hurt") takeEnvironmentalDamage(decision, effect.characterId, { kind: "damage", count: effect.count, sides: effect.sides, damageType: effect.damageType });
    else decision.applyStory(round.number, effect);
  }
  proposeMove(decision, round.number, held);
  decision.emit({ kind: "roundResolved", roundNumber: round.number, quiet: false });
  decision.request({ kind: "narrate", roundNumber: round.number });
}

const effectOrder = { transitionScene: 0, setFlag: 1, spendGold: 1, revealClue: 2, grantReward: 2, grantKeepsake: 2, notice: 2, advanceTime: 2, setWeather: 2, hurt: 3, startEncounter: 3, advanceClock: 4 } as const;

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
    member.characterId !== null && state.characters[member.characterId] !== undefined && !isFallen(state, member.characterId)
      ? [member.characterId]
      : [],
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
