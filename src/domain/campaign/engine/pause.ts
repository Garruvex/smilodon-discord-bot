import type { Decision } from "./decision.js";
import { rollTimerId, roundTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { activeEncounter, turnTimerId } from "./combat/combat-flow.js";

// Stops play on purpose (plan §5, Timers): the organizer pauses, or the system
// does after a restart so no deadline fires unattended. Every timer is
// cancelled and held work waits; the organizer's continue re-arms fresh
// windows and picks the held work back up. Pausing twice changes nothing.
export function pauseCampaign(decision: Decision, reason: "organizer" | "recovery"): Rejection | null {
  const { state, ctx } = decision;
  if (reason === "recovery") {
    if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  } else if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) {
    return { code: "notOrganizer" };
  }
  if (state.pausedBy !== null) return null;

  if (state.round?.status === "collecting" && state.round.closesAt !== null) {
    decision.request({ kind: "cancelTimer", timerId: roundTimerId(state.round.number) });
  }
  for (const check of Object.values(state.checks)) {
    if (check.status === "pending" && check.deadline !== null) decision.request({ kind: "cancelTimer", timerId: rollTimerId(check.id) });
  }
  const encounter = activeEncounter(decision);
  if (encounter !== null && encounter.turnEndsAt !== null) {
    decision.request({ kind: "cancelTimer", timerId: turnTimerId(encounter.id, encounter.turnNumber) });
  }
  decision.emit({ kind: "campaignPaused", reason });
  decision.request({ kind: "deliver", delivery: { kind: "campaignPaused", reason } });
  return null;
}

