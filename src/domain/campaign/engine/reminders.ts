import type { ReminderTarget } from "./engine-request.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";
import { isPresent } from "../combat/combat-state.js";

// A window shorter than this needs no nudge: the countdown on the panel is
// enough (Live pacing). Play-by-post windows are hours long, and a player who
// forgot deserves a word at the halfway point.
export const minReminderWindowMs = 10 * 60 * 1000;

function reminderTimerId(target: ReminderTarget): string {
  switch (target.kind) {
    case "round":
      return `remind:round:${target.roundNumber}:${target.closesAt}`;
    case "roll":
      return `remind:roll:${target.checkId}:${target.deadline}`;
    case "turn":
      return `remind:turn:${target.encounterId}:${target.turnNumber}:${target.endsAt}`;
  }
}

function deadlineOf(target: ReminderTarget): number {
  return target.kind === "round" ? target.closesAt : target.kind === "roll" ? target.deadline : target.endsAt;
}

// Asks for a reminder at the halfway point of a window that just opened.
// Nothing is cancelled when the window ends early or is moved: the reminder
// carries the deadline it was made for, and a reminder for a deadline that is
// no longer the current one does nothing (see remind).
export function scheduleReminder(decision: Decision, target: ReminderTarget): void {
  const now = decision.ctx.now;
  const deadline = deadlineOf(target);
  if (deadline - now < minReminderWindowMs) return;
  decision.request({
    kind: "startTimer",
    timer: { kind: "reminder", timerId: reminderTimerId(target), dueAt: now + Math.floor((deadline - now) / 2), target },
  });
}

// The halfway timer fired. The table is told only if the wait is still going
// on for the same deadline; the reminder changes no state.
export function remind(decision: Decision, target: ReminderTarget): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const { state } = decision;
  if (state.status !== "active" || state.pausedBy !== null) return null;
  if (target.kind === "round") {
    const round = state.round;
    if (round?.number !== target.roundNumber || round.status !== "collecting" || round.closesAt !== target.closesAt) return null;
  } else if (target.kind === "roll") {
    const check = state.checks[target.checkId];
    if (check?.status !== "pending" || check.deadline !== target.deadline) return null;
  } else {
    const encounter = state.encounter;
    if (encounter === null || encounter.status !== "active" || encounter.id !== target.encounterId) return null;
    if (encounter.turnNumber !== target.turnNumber || encounter.turnEndsAt !== target.endsAt) return null;
    const current = encounter.combatants[encounter.order[encounter.turnIndex] ?? ""];
    if (current === undefined || !isPresent(current)) return null;
  }
  decision.request({ kind: "deliver", delivery: { kind: "timerReminder", target } });
  return null;
}
