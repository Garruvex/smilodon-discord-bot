import { assertNever } from "../core/assert-never.js";
import type { CharacterId, UserId } from "../core/ids.js";
import type { CampaignState, CheckState, MemberState, RoundState, Submission } from "../state/campaign-state.js";
import type { CombatEvent } from "../combat/combat-events.js";
import type { HeroStatus } from "../combat/combatant-profile.js";
import { evolveEncounter } from "../combat/evolve-combat.js";
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
          effects: [],
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
        ...updateRound(state, (round) => ({ ...round, status: "resolving", resolutions: event.resolutions, effects: event.effects })),
        checks: { ...state.checks, ...checks },
      };
    }
    case "checkRollStarted":
      return updateCheck(state, event.checkId, (check) => ({ ...check, status: "rolling", timedOut: event.timedOut }));
    case "checkResolved":
      return updateCheck(state, event.checkId, (check) => ({ ...check, status: "resolved", result: event.result }));
    case "roundResolved":
      return state.round?.number === event.roundNumber ? { ...state, round: null } : state;
    case "sceneTransitioned":
      return { ...state, sceneId: event.sceneId };
    case "encounterQueued":
      return { ...state, pendingEncounter: event.encounter };
    case "clockAdvanced":
      return { ...state, clocks: { ...state.clocks, [event.clockId]: { segments: event.segments, filled: event.filled } } };
    case "clueRevealed":
      return { ...state, clues: [...state.clues, { id: event.clueId, text: event.text }] };
    case "memberMarkedAway":
      return updateMember(state, event.userId, (member) => ({ ...member, availability: "away", consecutiveMisses: 0 }));
    case "memberReturned":
      return updateMember(state, event.userId, (member) => ({ ...member, availability: "present", consecutiveMisses: 0 }));
    case "waitingForPlayers":
      return { ...state, status: "waitingForPlayers" };
    case "plannerFailed":
    case "planRetryRequested":
      // History only: the round stays in planning until the next command.
      return state;
    case "narrationRecorded":
      return { ...state, lastNarratedRound: Math.max(state.lastNarratedRound, event.roundNumber) };
    case "ledgerFactRecorded": {
      const entry = state.ledger[event.entityId];
      const fact = { text: event.fact, visibility: event.visibility };
      return {
        ...state,
        ledger: {
          ...state.ledger,
          [event.entityId]: {
            entityId: event.entityId,
            canonicalName: entry?.canonicalName ?? event.canonicalName,
            facts: [...(entry?.facts ?? []), fact],
          },
        },
      };
    }
    case "resumed": {
      const active: CampaignState = { ...state, status: "active" };
      return Object.entries(event.checkDeadlines).reduce(
        (next, [checkId, deadline]) => updateCheck(next, checkId, (check) => ({ ...check, deadline })),
        active,
      );
    }
    case "encounterStarted":
    case "initiativeRolled":
    case "turnOrderSet":
    case "turnStarted":
    case "stoodUp":
    case "combatantMoved":
    case "combatantEngaged":
    case "combatantWithdrew":
    case "moveInterrupted":
    case "moveCleared":
    case "actionTaken":
    case "resolutionDeclared":
    case "checkRolled":
    case "effectRollsRequested":
    case "effectRolled":
    case "combatantHpChanged":
    case "conditionAdded":
    case "effectAdded":
    case "effectsRemoved":
    case "sneakAttackUsed":
    case "concentrationStarted":
    case "concentrationEnded":
    case "concentrationSaveRequested":
    case "concentrationSaveRolled":
    case "resolutionFinished":
    case "deathSaveRequested":
    case "deathSaveRolled":
    case "combatantFled":
    case "turnEnded":
    case "turnDeferred":
    case "encounterEnded":
    case "combatNarrationRecorded":
      return evolveCombat(state, event);
    case "restTaken":
      return { ...state, heroStatus: { ...state.heroStatus, ...event.heroStatus } };
    default:
      return assertNever(event);
  }
}

// A finished fight writes the heroes' HP and spent resources back to the campaign.
// After a victory the party binds each other's wounds: anyone at 0 HP is back
// on their feet with 1 HP (a stand-in until the death rules are decided).
function evolveCombat(state: CampaignState, event: CombatEvent): CampaignState {
  const encounter = evolveEncounter(state.encounter, event);
  if (event.kind === "encounterStarted") {
    return { ...state, encounter, pendingEncounter: null, encounterHistory: [...state.encounterHistory, event.encounter.id] };
  }
  if (event.kind !== "encounterEnded" || encounter === null) return { ...state, encounter };
  const heroStatus: Record<CharacterId, HeroStatus> = { ...state.heroStatus };
  for (const combatant of Object.values(encounter.combatants)) {
    if (combatant.source.kind !== "hero") continue;
    const id = combatant.source.characterId;
    heroStatus[id] = {
      ...heroStatus[id],
      hp: encounter.outcome === "victory" ? Math.max(1, combatant.hp) : combatant.hp,
      resources: combatant.resources,
    };
  }
  return { ...state, encounter, heroStatus };
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
