// Moving in a fight, and the opportunity attacks it provokes: a move waits for them, then happens if the mover can still move.
import { currentCombatant, engagedWith, isActive, type Combatant, type ResolutionState, type TurnPlanRemainder } from "../../combat/combat-state.js";
import { avoidsOpportunityAttacks, conditionLookup } from "../../effects/effect-queries.js";
import type { Decision } from "../decision.js";
import { declareWeaponAttack } from "./combat-actions.js";
import { continuePlan, endTurn } from "./turn-flow.js";
import { activeEncounter, isPlayerControlled } from "./combat-flow.js";

// Leaving a hostile creature's reach without Disengage provokes an
// opportunity attack from each able foe, resolved before the move happens.
// Players' heroes take their opportunity attacks automatically for now; the
// Discord reaction prompt (panel spec: Reactions) arrives with milestone 2.
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
  decision.emit({ kind: "moveInterrupted", move: { ...move, provokers: rest } });
  const provoker = encounter.combatants[provokerId];
  const melee = provoker?.attacks.find((attack) => attack.range.kind === "melee");
  if (provoker === undefined || melee === undefined || !isActive(provoker) || !provoker.budget.reaction) {
    nextOpportunityAttack(decision);
    return;
  }
  if (declareWeaponAttack(decision, provoker, mover.id, melee, "opportunity") !== null) nextOpportunityAttack(decision);
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
  // The mover went down mid-move: an engine-played turn simply ends.
  const encounter = activeEncounter(decision);
  if (mover !== undefined && encounter !== null && currentCombatant(encounter)?.id === mover.id && !isPlayerControlled(decision, mover)) {
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
  const actor = activeEncounter(decision)?.combatants[resolution.actorId];
  if (actor !== undefined && !isPlayerControlled(decision, actor)) endTurn(decision);
}
