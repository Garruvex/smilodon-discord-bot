// The order of a fight's turns: what happens when one starts (clocks, standing up, triggers), how a foe or an autopilot plays it, and how it ends.
import { scheduleReminder } from "../reminders.js";
import { currentCombatant, isActive, isPresent, type Combatant, type TurnPlanRemainder } from "../../combat/combat-state.js";
import { bonusDiceFor, canAct, conditionLookup, effectsDueAt, hasCondition } from "../../effects/effect-queries.js";
import { engageCost } from "../../combat/positioning.js";
import { engageProblem, moveProblem } from "../../combat/turn-rules.js";
import { chooseAutopilotPlan, chooseMonsterPlan, type TurnPlan } from "../../combat/tactics.js";
import type { D20TestSpec } from "../../dice/d20-test.js";
import { deadlineAfter, type Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { beginTriggers } from "./effect-triggers.js";
import { endConcentration } from "./resolution.js";
import { declareAreaAttack, declareWeaponAttack } from "./combat-actions.js";
import { applyHealing } from "./damage.js";
import { startMove } from "./movement.js";
import { isProtected, stabilize } from "./death-saves.js";
import { activeEncounter, currentOf, endIfDecided, isPlayerControlled } from "./combat-flow.js";

// A chain of engine-played turns (monsters, autopilot, skipped heroes) must
// stop at a player's turn or a roll; this guards against an engine bug
// looping forever inside one decision.
export const maxTurnsPerDecision = 64;

export const prone = "condition:prone";

// A player's turn that had a timer before the pause gets a fresh full one.
export function rearmedTurnDeadline(decision: Decision): number | null {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.status !== "active" || encounter.turnEndsAt === null) return null;
  return deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds);
}

// Starts the turn that was due when the table emptied.
export function resumeCombat(decision: Decision): void {
  const deferred = activeEncounter(decision)?.deferredTurn;
  if (deferred != null) beginTurn(decision, deferred.turnIndex, deferred.round);
}

export function beginTurn(decision: Decision, turnIndex: number, round: number): void {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.order.length === 0) return;
  // Paused while nobody is present; continue starts this turn.
  if (decision.state.status !== "active") {
    decision.emit({ kind: "turnDeferred", turnIndex, round });
    return;
  }
  if (decision.countTurnStart() > maxTurnsPerDecision) throw new Error("Combat turn chain did not stop at a player's turn or a roll.");

  // Skip combatants who are out of the fight.
  let index = turnIndex;
  let currentRound = round;
  for (let skipped = 0; skipped < encounter.order.length; skipped += 1) {
    const candidate = encounter.combatants[encounter.order[index] ?? ""];
    if (candidate !== undefined && isPresent(candidate)) break;
    index += 1;
    if (index >= encounter.order.length) {
      index = 0;
      currentRound += 1;
    }
  }
  const combatant = encounter.combatants[encounter.order[index] ?? ""];
  if (combatant === undefined || !isPresent(combatant)) return;

  // A new round: the Narrator describes the one that just finished.
  if (currentRound > encounter.round) decision.request({ kind: "narrateCombat", encounterId: encounter.id, round: encounter.round, final: false });

  const playerTurn = isPlayerControlled(decision, combatant) && isActive(combatant);
  const endsAt = playerTurn ? deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds) : null;
  const turnNumber = encounter.turnNumber + 1;
  decision.emit({ kind: "turnStarted", combatantId: combatant.id, turnIndex: index, round: currentRound, turnNumber, endsAt });
  decision.request({ kind: "deliver", delivery: { kind: "combatTurn", encounterId: encounter.id, combatantId: combatant.id } });
  if (endsAt !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "combatTurn", timerId: turnTimerId(encounter.id, turnNumber), dueAt: endsAt, encounterId: encounter.id, turnNumber },
    });
    scheduleReminder(decision, { kind: "turn", encounterId: encounter.id, turnNumber, endsAt });
  }
  expireDue(decision, combatant.id, "start", currentRound);

  // Standing up from prone costs half the creature's speed.
  const lookup = conditionLookup(decision.ctx.rules.content);
  const fresh = activeEncounter(decision)?.combatants[combatant.id] ?? combatant;
  if (isActive(fresh) && hasCondition(fresh, prone, lookup)) decision.emit({ kind: "stoodUp", combatantId: fresh.id, feet: Math.floor(fresh.speed / 2) });
  // Effects that act at the start of the turn (poison, burning) run before anything else;
  // the turn goes on once the last one has.
  if (beginTriggers(decision, combatant.id, "start")) return;
  continueTurn(decision, combatant.id);
}

// The rest of a turn once its start-of-turn effects are done: an incapacitated
// creature loses it, a foe plays its plan, a downed hero rolls a death save, a
// present player gets the menu.
export function continueTurn(decision: Decision, combatantId: string): void {
  const encounter = activeEncounter(decision);
  const combatant = encounter?.combatants[combatantId];
  if (encounter == null || combatant === undefined) return;
  if (!isPresent(combatant)) {
    endTurn(decision);
    return;
  }
  const playerTurn = isPlayerControlled(decision, combatant) && isActive(combatant);
  // An incapacitated creature loses its turn.
  if (isActive(combatant) && !canAct(combatant, conditionLookup(decision.ctx.rules.content))) {
    endTurn(decision);
    return;
  }

  if (combatant.side === "foes") {
    const fraction = combatant.fleeBelowHpFraction;
    if (fraction !== null && combatant.hp < combatant.maxHp * fraction) {
      decision.emit({ kind: "combatantFled", combatantId: combatant.id });
      decision.request({ kind: "deliver", delivery: { kind: "combatBeat", encounterId: encounter.id, combatantId: combatant.id, beat: "fled" } });
      if (!endIfDecided(decision)) endTurn(decision);
      return;
    }
    regenerate(decision, combatant);
    playPlan(decision, currentOf(decision, combatant), chooseMonsterPlan(activeEncounter(decision) ?? encounter, currentOf(decision, combatant)));
    return;
  }
  if (combatant.condition === "unconscious") {
    // Protected while away: no death saves; the hero is simply stable.
    if (isProtected(decision, combatant)) {
      stabilize(decision, combatant);
      endTurn(decision);
      return;
    }
    const current = activeEncounter(decision) ?? encounter;
    const sequence = current.sequence + 1;
    const rollId = `${encounter.id}:roll:${sequence}`;
    const spec: D20TestSpec = { mode: "normal", modifier: 0, bonusDice: bonusDiceFor(combatant, "save") };
    decision.emit({ kind: "deathSaveRequested", combatantId: combatant.id, rollId, pending: { purpose: "deathSave", combatantId: combatant.id, spec }, sequence });
    decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec } });
    return;
  }
  if (combatant.condition === "stable") {
    endTurn(decision);
    return;
  }
  if (!playerTurn) playPlan(decision, currentOf(decision, combatant), chooseAutopilotPlan(activeEncounter(decision) ?? encounter, currentOf(decision, combatant)));
}

// Lasting effects whose clock has run out at this creature's turn boundary end
// (Bless at the start of the caster's turn once its rounds are up, Guiding Bolt
// at the end of the caster's next turn). An effect held up by concentration takes
// the whole spell down with it.
export function expireDue(decision: Decision, creatureId: string, boundary: "start" | "end", round: number): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const due = effectsDueAt(Object.values(encounter.combatants), creatureId, boundary, round);
  if (due.length === 0) return;
  const held = new Set(due.flatMap(({ effects }) => effects.flatMap((effect) => (effect.concentrationId === null ? [] : [effect.concentrationId]))));
  for (const concentrationId of held) {
    const caster = Object.values(encounter.combatants).find((combatant) => combatant.concentration?.resolutionId === concentrationId);
    if (caster !== undefined) endConcentration(decision, caster.id, "expired");
  }
  for (const { holderId, effects } of effectsDueAt(Object.values(activeEncounter(decision)?.combatants ?? {}), creatureId, boundary, round)) {
    decision.emit({ kind: "effectsRemoved", combatantId: holderId, effectIds: effects.map((effect) => effect.id), reason: "expired" });
  }
}

// Regeneration: a monster heals at the start of its turn, unless damage of a kind that
// stops it landed since its last one (which lets it regenerate again the turn after).
function regenerate(decision: Decision, monster: Combatant): void {
  const trait = monster.traits.find((entry) => entry.kind === "regeneration");
  if (trait === undefined || !isActive(monster)) return;
  if (monster.regenBlocked) {
    decision.emit({ kind: "monsterStateChanged", combatantId: monster.id, regenBlocked: false });
    return;
  }
  if (monster.hp < monster.maxHp) applyHealing(decision, monster, trait.amount);
}

// Executes an engine-chosen plan through the same steps players use.
export function playPlan(decision: Decision, combatant: Combatant, plan: TurnPlan): void {
  if (plan.disengage) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "disengage", bonus: true });
  if (plan.dash) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "dash", bonus: false });
  if (plan.dodge) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "dodge", bonus: false });
  continuePlan(decision, combatant.id, { moves: plan.moves, engage: plan.engage, attack: plan.attack, area: plan.area });
}

export function continuePlan(decision: Decision, combatantId: string, plan: TurnPlanRemainder): void {
  const encounter = activeEncounter(decision);
  const combatant = encounter?.combatants[combatantId];
  if (encounter == null || combatant === undefined) return;
  const content = decision.ctx.rules.content;
  const [next, ...rest] = plan.moves;
  if (next !== undefined) {
    // moveProblem, not a raw edge/budget check: a hindered creature
    // (grappled, restrained, paralyzed, stunned) has no movement left even
    // if combatant.budget.movement itself is nonzero (turn-rules.ts's
    // movementLeft is what zeroes it), and automated movement must be held
    // to the same legality a player's own move command is.
    const checked = moveProblem(encounter, combatant, next, content);
    if ("value" in checked) {
      startMove(decision, combatant, "move", next, checked.value.feet, { ...plan, moves: rest });
      return;
    }
  }
  const current = activeEncounter(decision)?.combatants[combatantId] ?? combatant;
  if (!isActive(current)) {
    endTurn(decision);
    return;
  }
  if (plan.engage !== null) {
    const target = activeEncounter(decision)?.combatants[plan.engage];
    if (target !== undefined && engageProblem(activeEncounter(decision) ?? encounter, current, plan.engage, content) === null) {
      decision.emit({ kind: "combatantEngaged", combatantId: current.id, targetId: target.id, feet: engageCost });
    }
  }
  if (plan.area != null) {
    const attacker = activeEncounter(decision)?.combatants[combatantId] ?? current;
    if (declareAreaAttack(decision, attacker, plan.area.area, plan.area.targetIds) === null) return;
  }
  if (plan.attack !== null) {
    const attacker = activeEncounter(decision)?.combatants[combatantId] ?? current;
    if (declareWeaponAttack(decision, attacker, plan.attack.targetId, plan.attack.option, "action") === null) return;
  }
  endTurn(decision);
}

export function endTurn(decision: Decision): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const combatant = currentCombatant(encounter);
  if (combatant !== undefined) {
    if (encounter.turnEndsAt !== null) decision.request({ kind: "cancelTimer", timerId: turnTimerId(encounter.id, encounter.turnNumber) });
    // Effects that act at the end of the turn (a save that breaks a hold) run first.
    if (beginTriggers(decision, combatant.id, "end")) return;
  }
  finishTurn(decision);
}

// The turn's end once its end-of-turn effects are done: clocks run out, the next creature's turn begins.
export function finishTurn(decision: Decision): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const combatant = currentCombatant(encounter);
  if (combatant !== undefined) {
    expireDue(decision, combatant.id, "end", encounter.round);
    decision.emit({ kind: "turnEnded", combatantId: combatant.id });
  }
  if (endIfDecided(decision)) return;
  const next = encounter.turnIndex + 1;
  if (next >= encounter.order.length) beginTurn(decision, 0, encounter.round + 1);
  else beginTurn(decision, next, encounter.round);
}

// A turn boundary's effects are all done: the fight may be over, otherwise the turn goes on.
export function resumeAfterTriggers(decision: Decision, boundary: "start" | "end", creatureId: string): void {
  if (endIfDecided(decision)) return;
  if (boundary === "start") continueTurn(decision, creatureId);
  else finishTurn(decision);
}

// A turn timer that fires mid-resolution (an attack, a reaction, an opening
// move's opportunity attacks) can't run the away policy yet — there is
// nothing sensible to play on top of a decision already in flight — but
// doing nothing would lose the timeout outright: the worker that delivered
// this event has already consumed it, so if the wait for a response never
// resolves on its own (a reaction prompt nobody answers), the turn would
// never end. Asking for another timer shortly retries once the turn frees up.
export const turnTimerRetryMs = 5000;

export function turnTimerExpired(decision: Decision, encounterId: string, turnNumber: number): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const encounter = activeEncounter(decision);
  if (encounter?.id !== encounterId || encounter.turnNumber !== turnNumber) return null;
  if (decision.state.status !== "active") return null;
  if (encounter.resolution !== null || encounter.pendingMove !== null || encounter.pendingTriggers !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "combatTurn", timerId: turnTimerId(encounterId, turnNumber), dueAt: decision.ctx.now + turnTimerRetryMs, encounterId, turnNumber },
    });
    return null;
  }
  const combatant = currentCombatant(encounter);
  if (combatant === undefined) return null;
  // Apply the away policy to what is left of the turn, then end it once.
  if (combatant.budget.action && isActive(combatant)) playPlan(decision, combatant, chooseAutopilotPlan(encounter, combatant));
  else endTurn(decision);
  return null;
}

export function turnTimerId(encounterId: string, turnNumber: number): string {
  return `turn:${encounterId}:${turnNumber}`;
}
