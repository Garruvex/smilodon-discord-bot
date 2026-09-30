import type { Decision } from "../decision.js";
import { retryEncounterId, roundTimerId } from "../ids.js";
import type { Rejection } from "../rejection.js";
import { beginEncounter } from "./combat-flow.js";

// The organizer sets a lost fight aside and plays it again from its start:
// the party is restored to how it stood when the fight began (HP, resources,
// gear, and any hero who fell), and the fight runs under a new ID so every
// roll is new. Allowed only once the fight is lost and nobody has acted in
// the exploration round that followed.
export function retryEncounter(decision: Decision): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  const encounter = state.encounter;
  if (encounter === null || encounter.status !== "ended" || encounter.outcome !== "defeat" || state.fightCheckpoint === null) {
    return { code: "notRetryable" };
  }
  const round = state.round;
  if (round !== null && (round.status !== "collecting" || Object.keys(round.submissions).length > 0)) return { code: "roundInProgress" };
  if (round !== null && round.closesAt !== null) decision.request({ kind: "cancelTimer", timerId: roundTimerId(round.number) });
  decision.emit({ kind: "encounterRetried", encounterId: encounter.id });
  beginEncounter(decision, { ...encounter.spec, id: retryEncounterId(encounter.id) });
  return null;
}
