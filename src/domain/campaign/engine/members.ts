import type { CharacterSheet } from "../character/character-sheet.js";
import { canMulticlassInto, classTemplates, isBuildClass } from "../character/character-build.js";
import { actsForOwner } from "../character/ownership.js";
import type { Skill } from "../rules/skills.js";
import type { CharacterId, CheckId, Instant, UserId } from "../core/ids.js";
import { isFallen, presentMembers, type CampaignState } from "../state/campaign-state.js";
import { deadlineAfter, type Decision } from "./decision.js";
import { rollTimerId, roundTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { scheduleReminder } from "./reminders.js";
import { reactionTimerId } from "./combat/reactions.js";
import { opportunityAttackTimerId } from "./combat/movement.js";
import { awayRestriction, beginEncounter, onMemberAway, rearmedTurnDeadline, resumeCombat, turnTimerId } from "./combat/combat-flow.js";
import { closeIfEveryoneResponded, enterWaiting, finishReadyCheck, finishRoundIfResolved, openRound } from "./rounds.js";

// A player marks themselves away, or the organizer marks them. An open
// window's unanswered slot is excused rather than counted as a miss; a
// submitted action stands.
// Whether the actor may act for this hero's owner in a fight (see character/ownership.ts).
export { actsForOwner };

// The hero this player controls right now: on a fight turn that belongs to an
// away friend who named them, that friend's hero; otherwise their own. The turn
// menu and the controls it sends use this one rule, so what is shown is what is acted on.
export function actingHero(state: CampaignState, userId: UserId): CharacterId | null {
  const own = state.members[userId]?.characterId ?? null;
  const encounter = state.encounter;
  const turnOf = encounter === null || encounter.status !== "active" ? undefined : encounter.combatants[encounter.order[encounter.turnIndex] ?? ""];
  if (turnOf?.source.kind !== "hero") return own;
  const sheet = state.characters[turnOf.source.characterId];
  return sheet !== undefined && sheet.id !== own && actsForOwner(state, userId, sheet.ownerUserId) ? sheet.id : own;
}

// The owner names a proxy (or takes the grant back). Only for one's own hero,
// only another member of the table, and never the organizer's say over it.
export function grantProxy(decision: Decision, proxyUserId: UserId): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || state.members[ctx.actor.userId] === undefined) return { code: "notMember" };
  if (proxyUserId === ctx.actor.userId || state.members[proxyUserId] === undefined) return { code: "invalidProxy" };
  if (state.proxies?.[ctx.actor.userId] === proxyUserId) return null;
  decision.emit({ kind: "proxyGranted", ownerUserId: ctx.actor.userId, proxyUserId });
  return null;
}

export function revokeProxy(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || state.members[ctx.actor.userId] === undefined) return { code: "notMember" };
  if (state.proxies?.[ctx.actor.userId] !== undefined) decision.emit({ kind: "proxyRevoked", ownerUserId: ctx.actor.userId });
  return null;
}

export function markAway(decision: Decision, userId: UserId): Rejection | null {
  const refusal = checkSelfOrOrganizer(decision, userId);
  if (refusal !== null) return refusal;
  const member = decision.state.members[userId];
  if (member === undefined) return { code: "notMember" };
  if (member.availability === "away") return null;

  const reason = decision.ctx.actor.kind === "user" && decision.ctx.actor.userId === userId ? "self" : "organizer";
  if (reason === "self") {
    const restriction = awayRestriction(decision, userId);
    if (restriction !== null) return restriction;
  }
  decision.emit({ kind: "memberMarkedAway", userId, reason });
  onMemberAway(decision, userId);
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
  else finishReadyCheck(decision);
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
  // A deliberate pause is the organizer's to lift.
  if (state.pausedBy !== null && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (presentMembers(state).length === 0) return { code: "nobodyPresent" };

  const checkDeadlines: Record<CheckId, Instant | null> = {};
  for (const check of Object.values(state.checks)) {
    if (check.status === "pending") checkDeadlines[check.id] = deadlineAfter(ctx.now, state.pacing.rollSeconds);
  }
  const roundClosesAt = state.round?.status === "collecting" && state.round.closesAt !== null ? deadlineAfter(ctx.now, state.pacing.roundSeconds) : null;
  const turnEndsAt = rearmedTurnDeadline(decision);
  decision.emit({
    kind: "resumed",
    checkDeadlines,
    ...(roundClosesAt === null ? {} : { roundClosesAt }),
    ...(turnEndsAt === null ? {} : { turnEndsAt }),
  });
  if (roundClosesAt !== null && state.round !== null) {
    decision.request({ kind: "startTimer", timer: { kind: "roundWindow", timerId: roundTimerId(state.round.number), dueAt: roundClosesAt, roundNumber: state.round.number } });
    scheduleReminder(decision, { kind: "round", roundNumber: state.round.number, closesAt: roundClosesAt });
  }
  if (turnEndsAt !== null && state.encounter !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "combatTurn", timerId: turnTimerId(state.encounter.id, state.encounter.turnNumber), dueAt: turnEndsAt, encounterId: state.encounter.id, turnNumber: state.encounter.turnNumber },
    });
    scheduleReminder(decision, { kind: "turn", encounterId: state.encounter.id, turnNumber: state.encounter.turnNumber, endsAt: turnEndsAt });
  }
  // A reaction window that was waiting gets a fresh full timer.
  const waitingReaction = state.encounter?.resolution?.reaction;
  const reactionClosesAt = waitingReaction == null ? null : deadlineAfter(ctx.now, state.pacing.turnSeconds);
  if (state.encounter !== null && state.encounter.resolution !== null && waitingReaction != null && reactionClosesAt !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "combatReaction", timerId: reactionTimerId(state.encounter.resolution.id, waitingReaction.rollId), dueAt: reactionClosesAt, encounterId: state.encounter.id, resolutionId: state.encounter.resolution.id },
    });
  }
  // An opportunity attack offer that was waiting gets a fresh full timer too.
  const waitingOffer = state.encounter?.pendingMove?.offer;
  const offerProvoker = state.encounter?.pendingMove?.provokers[0];
  const offerClosesAt = waitingOffer == null ? null : deadlineAfter(ctx.now, state.pacing.turnSeconds);
  if (state.encounter !== null && waitingOffer != null && offerProvoker !== undefined && offerClosesAt !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "opportunityAttack", timerId: opportunityAttackTimerId(state.encounter.id, offerProvoker), dueAt: offerClosesAt, encounterId: state.encounter.id, combatantId: offerProvoker },
    });
  }
  for (const [checkId, dueAt] of Object.entries(checkDeadlines)) {
    if (dueAt !== null) {
      decision.request({ kind: "startTimer", timer: { kind: "roll", timerId: rollTimerId(checkId), dueAt, checkId } });
      scheduleReminder(decision, { kind: "roll", checkId, deadline: dueAt });
    }
  }

  const encounter = decision.state.encounter;
  if (encounter !== null && encounter.status !== "ended") {
    resumeCombat(decision);
    return null;
  }
  const round = decision.state.round;
  const pending = decision.state.pendingEncounter;
  if (round === null && pending !== null) {
    // Queued by a round that has been narrated: the fight starts now.
    // Otherwise the narration, still to come, starts it.
    if (decision.state.lastNarratedRound >= decision.state.lastRoundNumber) beginEncounter(decision, pending);
    return null;
  }
  if (round === null) return openRound(decision);
  if (round.status === "planning") decision.request({ kind: "plan", roundNumber: round.number });
  if (round.status === "resolving") finishRoundIfResolved(decision);
  return null;
}

// A player takes a hero: their first, or one to replace a fallen hero. The
// application supplies the sheet from the adventure's presets (starting gear,
// no loot from an earlier hero); the engine checks it fits this campaign: the
// party's level, known content, and a fresh ID. The hero plays from the next
// round or fight.
export function joinHero(decision: Decision, sheet: CharacterSheet): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== sheet.ownerUserId && ctx.actor.userId !== state.organizerId) {
    return { code: "notOrganizer" };
  }
  const member = state.members[sheet.ownerUserId];
  const current = member?.characterId ?? null;
  if (current !== null && state.characters[current] !== undefined && !isFallen(state, current)) return { code: "heroNotReplaceable" };
  const problems = heroProblems(state, sheet, decision);
  if (problems.length > 0) return { code: "invalidHero", problems };
  decision.emit({ kind: "heroJoined", sheet });
  decision.request({ kind: "heroImage", characterId: sheet.id });
  return null;
}

// A new hero starts at the level of the party's strongest living hero.
function heroProblems(state: CampaignState, sheet: CharacterSheet, decision: Decision): readonly string[] {
  const problems: string[] = [];
  const content = decision.ctx.rules.content;
  if (state.characters[sheet.id] !== undefined) problems.push(`Hero ${sheet.id} already exists.`);
  const living = Object.values(state.characters).filter((other) => !isFallen(state, other.id));
  const partyLevel = Math.max(1, ...living.map((other) => other.level));
  if (sheet.level !== partyLevel) problems.push(`A new hero starts at the party's level (${partyLevel}), not ${sheet.level}.`);
  if (!Number.isInteger(sheet.maxHp) || sheet.maxHp < 1) problems.push("Maximum HP must be at least 1.");
  for (const id of sheet.equipment) if (content.find(id)?.kind !== "item") problems.push(`Unknown item ${id}.`);
  for (const id of sheet.features) if (content.find(id)?.kind !== "feature") problems.push(`Unknown feature ${id}.`);
  for (const id of sheet.spellcasting?.spells ?? []) if (content.find(id)?.kind !== "spell") problems.push(`Unknown spell ${id}.`);
  return problems;
}

// Declares which class the hero's next level lands in — the class already
// being leveled, to cancel a multiclass plan, or a new one, checked against
// that class's SRD ability-score prerequisite now (grantExperience,
// combat/combat-flow.ts, checks it again when the level is actually
// reached, since scores can still change between now and then). The
// skillChoice, if given, is only spent — and only validated — once that
// level actually arrives and grants it.
export function chooseClassLevel(decision: Decision, characterId: CharacterId, buildClass: string, skillChoice?: Skill): Rejection | null {
  const { state, ctx } = decision;
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "notYourCharacter" };
  if (ctx.actor.kind === "user" && ctx.actor.userId !== sheet.ownerUserId && ctx.actor.userId !== state.organizerId) return { code: "notYourCharacter" };
  if (!isBuildClass(buildClass)) return { code: "unknownClass" };
  if (!canMulticlassInto(buildClass, sheet)) return { code: "multiclassRequirementNotMet" };
  const template = classTemplates[buildClass];
  const validSkill = skillChoice !== undefined && template.multiclassSkillChoices?.includes(skillChoice) === true ? skillChoice : undefined;
  decision.emit({ kind: "classLevelPlanChosen", characterId, buildClass, ...(validSkill === undefined ? {} : { skillChoice: validSkill }) });
  return null;
}

function checkSelfOrOrganizer(decision: Decision, userId: UserId): Rejection | null {
  const { actor } = decision.ctx;
  if (actor.kind === "system") return null;
  if (actor.userId === userId || actor.userId === decision.state.organizerId) return null;
  return { code: "notOrganizer" };
}
