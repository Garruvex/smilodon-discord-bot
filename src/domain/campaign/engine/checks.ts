import type { CheckId, RollId } from "../core/ids.js";
import { resolveD20Test, rollMatchesSpec, type D20TestRoll } from "../dice/d20-test.js";
import { classifyRollMoments } from "../dice/roll-moments.js";
import { naturalRollsOnChecks } from "../rules/house-rules.js";
import type { CheckState } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import { rollTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { finishRoundIfResolved } from "./rounds.js";

// The player clicked Roll on their pending check.
export function requestRoll(decision: Decision, checkId: CheckId): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user") return { code: "notYourCharacter" };
  const check = state.checks[checkId];
  if (check === undefined) return { code: "unknownCheck" };
  if (state.characters[check.characterId]?.ownerUserId !== ctx.actor.userId) return { code: "notYourCharacter" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (check.status !== "pending") return { code: "checkNotPending" };
  startRoll(decision, check, false);
  return null;
}

// The roll timer expired: roll that exact saved check once, labeled as timed
// out. A click that won the race leaves nothing to do.
export function rollTimerExpired(decision: Decision, checkId: CheckId): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const check = decision.state.checks[checkId];
  if (decision.state.status !== "active" || check?.status !== "pending") return null;
  startRoll(decision, check, true);
  return null;
}

// The roll worker saved a result. Re-recording the same result is a no-op,
// so a redelivered job cannot resolve a check twice.
export function recordRoll(decision: Decision, rollId: RollId, roll: D20TestRoll): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const check = Object.values(state.checks).find((candidate) => candidate.rollId === rollId);
  if (check === undefined) return { code: "unknownCheck" };
  if (check.status === "resolved") return null;
  if (check.status !== "rolling") return { code: "checkNotPending" };
  if (!rollMatchesSpec(roll, check.spec)) return { code: "rollMismatch" };

  const naturalRule = ctx.rules.houseRules.option(naturalRollsOnChecks);
  const outcome = resolveD20Test("abilityCheck", roll.d20.natural, roll.total, check.dc, naturalRule);
  const moments = classifyRollMoments({ kind: "abilityCheck", roll, target: check.dc, naturalRule });
  decision.emit({ kind: "checkResolved", checkId: check.id, result: { roll, success: outcome.success, moments } });
  decision.request({ kind: "deliver", delivery: { kind: "rollResult", checkId: check.id } });
  finishRoundIfResolved(decision);
  return null;
}

function startRoll(decision: Decision, check: CheckState, timedOut: boolean): void {
  if (!timedOut && check.deadline !== null) decision.request({ kind: "cancelTimer", timerId: rollTimerId(check.id) });
  decision.emit({ kind: "checkRollStarted", checkId: check.id, rollId: check.rollId, timedOut });
  decision.request({ kind: "roll", rollId: check.rollId, spec: check.spec });
  decision.request({ kind: "deliver", delivery: { kind: "rollStarted", checkId: check.id } });
}
