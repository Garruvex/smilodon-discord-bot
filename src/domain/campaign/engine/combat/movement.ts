// Moving in a fight, and the opportunity attacks it provokes: a move waits for them, then happens if the mover can still move.
import { currentCombatant, engagedWith, isActive, type Combatant, type EncounterState, type ResolutionState, type TurnPlanRemainder } from "../../combat/combat-state.js";
import { weaponTargets } from "../../combat/legal-targets.js";
import { avoidsOpportunityAttacks, conditionLookup } from "../../effects/effect-queries.js";
import { deadlineAfter, type Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { declareWeaponAttack } from "./combat-actions.js";
import { takeLegendaryAction } from "./legendary.js";
import { advanceTurn, continuePlan, endTurn } from "./turn-flow.js";
import { activeEncounter, isPlayerControlled, mayActFor } from "./combat-flow.js";

export const opportunityAttackTimerId = (encounterId: string, combatantId: string): string => `opportunity:${encounterId}:${combatantId}`;

// Leaving a hostile creature's reach without Disengage provokes an
// opportunity attack from each able foe, resolved before the move happens.
// An engine-played provoker (a monster) always takes it; a player-controlled
// one (a hero) is offered the choice — take it (spending the reaction) or
// hold it — the same reaction-window shape Shield uses, but triggered by the
// mover leaving reach rather than by being hit.
export function startMove(
  decision: Decision,
  mover: Combatant,
  kind: "move" | "withdraw",
  zoneId: string | null,
  feet: number,
  thenPlan: TurnPlanRemainder | null,
): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const provokers = avoidsOpportunityAttacks(mover, conditionLookup(decision.ctx.rules.content))
    ? []
    : engagedWith(encounter, mover.id)
        .filter((other) => other.side !== mover.side && isActive(other) && other.budget.reaction)
        .filter((other) => other.attacks.some((attack) => attack.range.kind === "melee"))
        .map((other) => other.id);
  if (provokers.length === 0) {
    performMove(decision, mover.id, kind, zoneId, feet);
    if (thenPlan !== null) continuePlan(decision, mover.id, thenPlan);
    return;
  }
  decision.emit({ kind: "moveInterrupted", move: { combatantId: mover.id, kind, zoneId, feet, provokers, thenPlan } });
  nextOpportunityAttack(decision);
}

// Asks (or auto-resolves) the next provoker in line. Stops and waits when
// that provoker's player must answer; the answer (or its timer) calls back
// in to continue with whoever is next.
export function nextOpportunityAttack(decision: Decision): void {
  const encounter = activeEncounter(decision);
  const move = encounter?.pendingMove;
  if (encounter == null || move == null) return;
  const mover = encounter.combatants[move.combatantId];
  const [provokerId, ...rest] = move.provokers;
  if (mover === undefined || !isActive(mover) || provokerId === undefined) {
    completeMove(decision);
    return;
  }
  const provoker = encounter.combatants[provokerId];
  const melee = provoker?.attacks.find((attack) => attack.range.kind === "melee");
  if (provoker === undefined || melee === undefined || !isActive(provoker) || !provoker.budget.reaction) {
    decision.emit({ kind: "moveInterrupted", move: { ...move, provokers: rest } });
    nextOpportunityAttack(decision);
    return;
  }
  if (isPlayerControlled(decision, provoker)) {
    offerOpportunityAttack(decision, encounter, provokerId);
    return;
  }
  decision.emit({ kind: "moveInterrupted", move: { ...move, provokers: rest } });
  if (declareWeaponAttack(decision, provoker, mover.id, melee, "opportunity") !== null) nextOpportunityAttack(decision);
}

function offerOpportunityAttack(decision: Decision, encounter: EncounterState, provokerId: string): void {
  const closesAt = deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds);
  decision.emit({ kind: "opportunityAttackOffered", combatantId: provokerId, closesAt });
  decision.request({ kind: "deliver", delivery: { kind: "opportunityAttackOffered", encounterId: encounter.id, combatantId: provokerId } });
  if (closesAt !== null) {
    decision.request({ kind: "startTimer", timer: { kind: "opportunityAttack", timerId: opportunityAttackTimerId(encounter.id, provokerId), dueAt: closesAt, encounterId: encounter.id, combatantId: provokerId } });
  }
}

// The provoker's player answers: take the attack, or decline and hold the
// reaction. "system" answers for a timer or an away player and always declines.
export function answerOpportunityAttack(decision: Decision, combatantId: string, take: boolean, by: "player" | "system"): Rejection | null {
  const encounter = activeEncounter(decision);
  const move = encounter?.pendingMove;
  if (encounter == null || move == null || move.provokers[0] !== combatantId || move.offer == null) return { code: "noOpportunityAttack" };
  if (by === "player" && decision.state.status !== "active") return { code: "campaignWaiting" };
  const provoker = encounter.combatants[combatantId];
  if (provoker === undefined) return { code: "noOpportunityAttack" };
  if (by === "player" && !mayActFor(decision, provoker)) return { code: "notYourCharacter" };

  decision.request({ kind: "cancelTimer", timerId: opportunityAttackTimerId(encounter.id, combatantId) });
  decision.emit({ kind: "opportunityAttackAnswered", combatantId, took: take });
  decision.emit({ kind: "moveInterrupted", move: { ...move, provokers: move.provokers.slice(1), offer: null } });

  const mover = encounter.combatants[move.combatantId];
  const melee = provoker.attacks.find((attack) => attack.range.kind === "melee");
  if (take && mover !== undefined && melee !== undefined && isActive(mover) && isActive(provoker) && provoker.budget.reaction) {
    if (declareWeaponAttack(decision, provoker, mover.id, melee, "opportunity") !== null) nextOpportunityAttack(decision);
    return null;
  }
  nextOpportunityAttack(decision);
  return null;
}

// A window ran out of time: the provoker declines, holding the reaction.
export function opportunityAttackTimerExpired(decision: Decision, encounterId: string, combatantId: string): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const encounter = activeEncounter(decision);
  const move = encounter?.pendingMove;
  if (encounter?.id !== encounterId || move == null || move.provokers[0] !== combatantId || move.offer == null || decision.state.status !== "active") return null;
  return answerOpportunityAttack(decision, combatantId, false, "system");
}

// The provoker went away with a window open: it declines.
export function declineOpportunityAttackFor(decision: Decision, combatantId: string): void {
  const move = activeEncounter(decision)?.pendingMove;
  if (move?.provokers[0] === combatantId && move.offer != null) answerOpportunityAttack(decision, combatantId, false, "system");
}

export function completeMove(decision: Decision): void {
  const move = activeEncounter(decision)?.pendingMove;
  if (move == null) return;
  decision.emit({ kind: "moveCleared" });
  const mover = activeEncounter(decision)?.combatants[move.combatantId];
  if (mover !== undefined && isActive(mover)) {
    performMove(decision, mover.id, move.kind, move.zoneId, move.feet);
    if (move.thenPlan !== null) continuePlan(decision, mover.id, move.thenPlan);
    return;
  }
  // The mover went down mid-move: their turn is over, whoever plays it. (A hero
  // dropped by an opportunity attack has nothing left to choose, so waiting for a
  // command would hold the fight until the turn timer ran out.)
  const encounter = activeEncounter(decision);
  if (mover !== undefined && encounter !== null && currentCombatant(encounter)?.id === mover.id) {
    endTurn(decision);
  }
}

export function performMove(decision: Decision, combatantId: string, kind: "move" | "withdraw", zoneId: string | null, feet: number): void {
  if (kind === "move" && zoneId !== null) decision.emit({ kind: "combatantMoved", combatantId, zoneId, feet });
  else decision.emit({ kind: "combatantWithdrew", combatantId, feet });
}

// Called when an action finishes: resume an interrupted move, or end a turn
// the engine is playing. Players end their own turns.
export function afterResolution(decision: Decision, resolution: ResolutionState): void {
  if (resolution.purpose === "opportunity") {
    nextOpportunityAttack(decision);
    return;
  }
  // A legendary action between turns: another monster may act, or the next turn begins.
  if (resolution.purpose === "legendary") {
    if (!takeLegendaryAction(decision)) advanceTurn(decision);
    return;
  }
  const encounter = activeEncounter(decision);
  const actor = encounter?.combatants[resolution.actorId];
  if (encounter == null || actor === undefined || isPlayerControlled(decision, actor)) return;
  if (resolution.source.kind === "weapon" && isActive(actor) && currentCombatant(encounter)?.id === actor.id && nextMultiattack(decision, encounter, actor)) return;
  endTurn(decision);
}

// Multiattack: the next swing of the Attack action, at the first weapon in the
// sequence that has a target in reach. True when one was declared.
function nextMultiattack(decision: Decision, encounter: EncounterState, actor: Combatant): boolean {
  const multiattack = actor.traits.find((trait) => trait.kind === "multiattack");
  if (multiattack === undefined || actor.budget.attacksLeft <= 0) return false;
  const content = decision.ctx.rules.content;
  const swung = multiattack.weapons.length - actor.budget.attacksLeft;
  for (const weapon of multiattack.weapons.slice(swung)) {
    const option = actor.attacks.find((attack) => attack.weapon === weapon);
    if (option === undefined) continue;
    const [target] = [...weaponTargets(encounter, actor, option, content)].sort((a, b) => (a.hp !== b.hp ? a.hp - b.hp : a.id.localeCompare(b.id)));
    if (target !== undefined && declareWeaponAttack(decision, actor, target.id, option, "action") === null) return true;
  }
  return false;
}
