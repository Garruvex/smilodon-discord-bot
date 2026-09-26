import { assertNever } from "../core/assert-never.js";
import type { ContentId } from "../rules/content-id.js";
import type { CharacterId, UserId } from "../core/ids.js";
import type { CampaignState, CheckState, ItemOffer, MemberState, RoundState, Submission } from "../state/campaign-state.js";
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
    case "gearChanged":
    case "combatNarrationRecorded":
      return evolveCombat(state, event);
    case "restTaken":
      return { ...state, heroStatus: { ...state.heroStatus, ...event.heroStatus } };
    case "itemOffered":
      return { ...state, offers: { ...state.offers, [event.offer.id]: event.offer }, offerCount: state.offerCount + 1 };
    case "offerAccepted":
      return acceptOffer(state, event.offerId);
    case "offerClosed":
      return withoutOffers(state, (offer) => offer.id === event.offerId);
    case "itemStashed":
      return moveItem(state, event.characterId, event.itemId, "toStash");
    case "itemTaken":
      return moveItem(state, event.characterId, event.itemId, "fromStash");
    case "lootFound":
      return { ...state, stash: [...state.stash, ...event.items], gold: state.gold + event.gold };
    case "itemUsed": {
      const sheet = state.characters[event.characterId];
      if (sheet === undefined) return state;
      const used: CampaignState = { ...state, characters: { ...state.characters, [sheet.id]: { ...sheet, equipment: removeFirst(sheet.equipment, event.itemId) } } };
      // In a fight the combatant carries the HP; it is written back when the fight ends.
      const status = state.heroStatus[sheet.id];
      if (status === undefined || (state.encounter !== null && state.encounter.status !== "ended")) return used;
      return { ...used, heroStatus: { ...used.heroStatus, [sheet.id]: { ...status, hp: Math.min(sheet.maxHp, status.hp + event.healed) } } };
    }
    case "heroJoined": {
      const sheet = event.sheet;
      const member = state.members[sheet.ownerUserId];
      const joined: MemberState = { userId: sheet.ownerUserId, characterId: sheet.id, availability: "present", consecutiveMisses: 0 };
      return { ...state, characters: { ...state.characters, [sheet.id]: sheet }, members: { ...state.members, [sheet.ownerUserId]: member === undefined ? joined : { ...member, characterId: sheet.id, consecutiveMisses: 0 } } };
    }
    default:
      return assertNever(event);
  }
}

// A finished fight writes the heroes' HP and spent resources back to the campaign.
// Anyone at 0 HP who has not died wakes with 1 HP: after a victory the party
// binds their wounds, and after a defeat the foes leave them beaten, not dead
// (captured, robbed, or left for dead; the story decides). A hero who failed
// three death saves stays dead and their gear joins the party stash.
function evolveCombat(state: CampaignState, event: CombatEvent): CampaignState {
  const encounter = evolveEncounter(state.encounter, event);
  if (event.kind === "encounterStarted") {
    return { ...state, encounter, pendingEncounter: null, encounterHistory: [...state.encounterHistory, event.encounter.id] };
  }
  if (event.kind !== "encounterEnded" || encounter === null) return { ...state, encounter };
  const heroStatus: Record<CharacterId, HeroStatus> = { ...state.heroStatus };
  const characters = { ...state.characters };
  let stash = state.stash;
  const fallen: CharacterId[] = [];
  for (const combatant of Object.values(encounter.combatants)) {
    if (combatant.source.kind !== "hero") continue;
    const id = combatant.source.characterId;
    const dead = combatant.condition === "dead";
    heroStatus[id] = { ...heroStatus[id], hp: dead ? 0 : Math.max(1, combatant.hp), resources: combatant.resources, ...(dead ? { dead: true } : {}) };
    const sheet = characters[id];
    if (dead && sheet !== undefined) {
      fallen.push(id);
      stash = [...stash, ...sheet.equipment];
      characters[id] = { ...sheet, equipment: [] };
    }
  }
  return withoutOffers({ ...state, encounter, heroStatus, characters, stash }, (offer) => fallen.includes(offer.fromCharacterId) || fallen.includes(offer.toCharacterId));
}

function withoutOffers(state: CampaignState, drop: (offer: ItemOffer) => boolean): CampaignState {
  const kept = Object.fromEntries(Object.entries(state.offers).filter(([, offer]) => !drop(offer)));
  return { ...state, offers: kept };
}

function removeFirst<T>(items: readonly T[], item: T): readonly T[] {
  const index = items.indexOf(item);
  return index < 0 ? items : [...items.slice(0, index), ...items.slice(index + 1)];
}

function moveItem(state: CampaignState, characterId: CharacterId, itemId: ItemId, direction: "toStash" | "fromStash"): CampaignState {
  const sheet = state.characters[characterId];
  if (sheet === undefined) return state;
  if (direction === "toStash") {
    return { ...state, characters: { ...state.characters, [characterId]: { ...sheet, equipment: removeFirst(sheet.equipment, itemId) } }, stash: [...state.stash, itemId] };
  }
  return { ...state, characters: { ...state.characters, [characterId]: { ...sheet, equipment: [...sheet.equipment, itemId] } }, stash: removeFirst(state.stash, itemId) };
}

// The giver's item goes to the receiver and the item asked for comes back;
// every other offer touching either item is no longer honest, so it closes.
function acceptOffer(state: CampaignState, offerId: string): CampaignState {
  const offer = state.offers[offerId];
  const from = offer === undefined ? undefined : state.characters[offer.fromCharacterId];
  const to = offer === undefined ? undefined : state.characters[offer.toCharacterId];
  if (offer === undefined || from === undefined || to === undefined) return state;
  const fromEquipment = offer.want === null ? removeFirst(from.equipment, offer.give) : [...removeFirst(from.equipment, offer.give), offer.want];
  const toEquipment = offer.want === null ? [...to.equipment, offer.give] : [...removeFirst(to.equipment, offer.want), offer.give];
  const moved: CampaignState = {
    ...state,
    characters: { ...state.characters, [from.id]: { ...from, equipment: fromEquipment }, [to.id]: { ...to, equipment: toEquipment } },
  };
  return withoutOffers(moved, (other) => other.id === offerId || other.fromCharacterId === from.id || other.fromCharacterId === to.id);
}

type ItemId = ContentId<"item">;

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
