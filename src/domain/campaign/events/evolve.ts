import { assertNever } from "../core/assert-never.js";
import type { CharacterId, UserId } from "../core/ids.js";
import type { CampaignState, CheckState, MemberState, RoundState, Submission } from "../state/campaign-state.js";
import type { CampaignEvent } from "./campaign-event.js";

// Applies one event. Pure: never validates and never fails. decide() is the
// only place rules are checked; an event that no longer fits the state (it
// cannot happen through decide) leaves the state unchanged.
export function evolve(state: CampaignState, event: CampaignEvent): CampaignState {
  switch (event.kind) {
    case "roundOpened":
      return {
        ...state,
        round: {
          number: event.roundNumber,
          status: "collecting",
          participants: event.participants,
          submissions: {},
          closesAt: event.closesAt,
          resolutions: {},
        },
        lastRoundNumber: event.roundNumber,
        checks: {},
      };
    case "actionSubmitted":
      return withSubmission(state, event.characterId, { kind: "action", text: event.text, revision: event.revision });
    case "passSubmitted":
      return withSubmission(state, event.characterId, { kind: "pass" });
    case "slotExcused":
      return updateRound(state, (round) => ({
        ...round,
        submissions: { ...round.submissions, [event.characterId]: { kind: "excused" } },
      }));
    case "roundClosed": {
      const missed: Record<CharacterId, Submission> = {};
      for (const characterId of event.missed) missed[characterId] = { kind: "missed" };
      const closed = updateRound(state, (round) => ({
        ...round,
        status: "planning",
        closesAt: null,
        submissions: { ...round.submissions, ...missed },
      }));
      if (event.reason !== "timer") return closed;
      return event.missed.reduce(
        (next, characterId) =>
          updateOwner(next, characterId, (member) => ({ ...member, consecutiveMisses: member.consecutiveMisses + 1 })),
        closed,
      );
    }
    case "roundPlanApplied": {
      const checks: Record<string, CheckState> = {};
      for (const check of event.checks) checks[check.id] = check;
      return {
        ...updateRound(state, (round) => ({ ...round, status: "resolving", resolutions: event.resolutions })),
        checks: { ...state.checks, ...checks },
      };
    }
    case "checkRollStarted":
      return updateCheck(state, event.checkId, (check) => ({ ...check, status: "rolling", timedOut: event.timedOut }));
    case "checkResolved":
      return updateCheck(state, event.checkId, (check) => ({ ...check, status: "resolved", result: event.result }));
    case "roundResolved":
      return state.round?.number === event.roundNumber ? { ...state, round: null } : state;
    case "memberMarkedAway":
      return updateMember(state, event.userId, (member) => ({ ...member, availability: "away", consecutiveMisses: 0 }));
    case "memberReturned":
      return updateMember(state, event.userId, (member) => ({ ...member, availability: "present", consecutiveMisses: 0 }));
    case "waitingForPlayers":
      return { ...state, status: "waitingForPlayers" };
    case "resumed": {
      const active: CampaignState = { ...state, status: "active" };
      return Object.entries(event.checkDeadlines).reduce(
        (next, [checkId, deadline]) => updateCheck(next, checkId, (check) => ({ ...check, deadline })),
        active,
      );
    }
    default:
      return assertNever(event);
  }
}

export function replay(initial: CampaignState, events: readonly CampaignEvent[]): CampaignState {
  return events.reduce(evolve, initial);
}

// A submission, including a pass, is a response: it resets the miss streak.
function withSubmission(state: CampaignState, characterId: CharacterId, submission: Submission): CampaignState {
  const next = updateRound(state, (round) => ({
    ...round,
    submissions: { ...round.submissions, [characterId]: submission },
  }));
  return updateOwner(next, characterId, (member) => ({ ...member, consecutiveMisses: 0 }));
}

function updateRound(state: CampaignState, update: (round: RoundState) => RoundState): CampaignState {
  return state.round === null ? state : { ...state, round: update(state.round) };
}

function updateCheck(state: CampaignState, checkId: string, update: (check: CheckState) => CheckState): CampaignState {
  const check = state.checks[checkId];
  return check === undefined ? state : { ...state, checks: { ...state.checks, [checkId]: update(check) } };
}

function updateMember(state: CampaignState, userId: UserId, update: (member: MemberState) => MemberState): CampaignState {
  const member = state.members[userId];
  return member === undefined ? state : { ...state, members: { ...state.members, [userId]: update(member) } };
}

function updateOwner(
  state: CampaignState,
  characterId: CharacterId,
  update: (member: MemberState) => MemberState,
): CampaignState {
  const ownerId = state.characters[characterId]?.ownerUserId;
  return ownerId === undefined ? state : updateMember(state, ownerId, update);
}
