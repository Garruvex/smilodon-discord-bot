import { availableSlots, type CombatantId, type EncounterState, type ResolutionState } from "../../combat/combat-state.js";
import { deadlineAfter, type Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, isPlayerControlled, mayActFor } from "./combat-flow.js";
import { proceedToEffects } from "./resolution.js";

// Divine Smite (SRD 5.1): unlike Shield, this never changes whether a hit
// lands, only its damage, so it pauses at settleCheck's later point — once
// the hit is already confirmed, not before. A slot declared up front on the
// attack itself (combatAttack's smiteSlot) skips this window entirely: this
// only ever offers when nothing was declared.

export const smiteTimerId = (resolutionId: string): string => `smite:${resolutionId}`;

// The landed hit's attacker could still spend a slot for bonus damage. True
// when a window opened (the caller stops); false leaves resolution.smiteSlot
// untouched, so resolution.ts's own fallback to a slot declared up front (or
// no smite at all) applies.
export function offerSmite(decision: Decision, encounter: EncounterState, resolution: ResolutionState, targetId: CombatantId): boolean {
  if (resolution.source.kind !== "weapon" || resolution.source.smiteSlot !== undefined || resolution.smiteSlot !== undefined) return false;
  const attacker = encounter.combatants[resolution.actorId];
  if (attacker === undefined || !isPlayerControlled(decision, attacker) || !attacker.traits.some((trait) => trait.kind === "divineSmite")) return false;
  const slots = availableSlots(attacker.resources);
  const options = Object.entries(slots)
    .map(([level, count]) => ({ slotLevel: Number(level), count }))
    .filter((slot) => slot.slotLevel > 0 && slot.count > 0)
    .sort((a, b) => a.slotLevel - b.slotLevel)
    .map((slot) => ({ slotLevel: slot.slotLevel }));
  if (options.length === 0) return false;
  const closesAt = deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds);
  decision.emit({ kind: "smiteOffered", resolutionId: resolution.id, smite: { targetId, options, closesAt } });
  decision.request({ kind: "deliver", delivery: { kind: "smiteOffered", encounterId: encounter.id, attackId: resolution.id } });
  if (closesAt !== null) {
    decision.request({ kind: "startTimer", timer: { kind: "combatSmite", timerId: smiteTimerId(resolution.id), dueAt: closesAt, encounterId: encounter.id, resolutionId: resolution.id } });
  }
  return true;
}

// The attacker answers: a slot level, or null to skip. "system" answers for
// a timer or an away player and is always a skip.
export function answerSmite(decision: Decision, combatantId: CombatantId, slotLevel: number | null, by: "player" | "system"): Rejection | null {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  const pending = resolution?.smite;
  if (encounter == null || resolution == null || pending == null || resolution.actorId !== combatantId) return { code: "noSmite" };
  if (by === "player" && decision.state.status !== "active") return { code: "campaignWaiting" };
  const attacker = encounter.combatants[combatantId];
  if (attacker === undefined) return { code: "noSmite" };
  if (by === "player" && !mayActFor(decision, attacker)) return { code: "notYourCharacter" };
  if (slotLevel !== null && !pending.options.some((option) => option.slotLevel === slotLevel)) return { code: "unknownFeature" };

  decision.request({ kind: "cancelTimer", timerId: smiteTimerId(resolution.id) });
  decision.emit({ kind: "smiteAnswered", resolutionId: resolution.id, combatantId, slotLevel });
  const after = activeEncounter(decision)?.resolution;
  const waiting = Object.values(activeEncounter(decision)?.pendingRolls ?? {}).some((roll) => roll.purpose === "check" && roll.resolutionId === resolution.id);
  if (after != null && !waiting && after.reaction == null) proceedToEffects(decision);
  return null;
}

// A window ran out of time: the attacker skips it.
export function smiteTimerExpired(decision: Decision, encounterId: string, resolutionId: string): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const encounter = activeEncounter(decision);
  const pending = encounter?.resolution?.smite;
  if (encounter?.id !== encounterId || encounter.resolution?.id !== resolutionId || pending == null || decision.state.status !== "active") return null;
  return answerSmite(decision, encounter.resolution.actorId, null, "system");
}

// The attacker went away with a window open: it is skipped.
export function declineSmiteFor(decision: Decision, combatantId: CombatantId): void {
  const pending = activeEncounter(decision)?.resolution?.smite;
  if (activeEncounter(decision)?.resolution?.actorId === combatantId && pending != null) answerSmite(decision, combatantId, null, "system");
}
