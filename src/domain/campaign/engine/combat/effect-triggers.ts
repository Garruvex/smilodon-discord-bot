import type { PendingCombatRoll } from "../../combat/combat-state.js";
import type { D20TestSpec } from "../../dice/d20-test.js";
import { resolveD20Test } from "../../dice/d20-test.js";
import type { RollId } from "../../core/ids.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../../dice/roll-spec.js";
import { bonusDiceFor, conditionLookup, saveBias, triggersDueAt } from "../../effects/effect-queries.js";
import { resolveRollMode } from "../../dice/roll.js";
import { naturalRollsOnChecks } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter } from "./combat-flow.js";
import { applyDamage } from "./resolution.js";

// Effects that act at a turn boundary (poison, burning, a hold that a saving
// throw can break). When a creature's turn starts or ends, the triggers due at
// that boundary run one at a time in the order their effects were applied: each
// asks for its dice through a saved roll, is applied, and only then does the next
// look at the state as it now stands (damage can down a creature, a save can lift
// what held it). The turn resumes when the last one is done.

// Starts the triggers due at this boundary. True when a roll is now pending, and
// the caller must stop: the turn resumes through resumeAfterTriggers.
export function beginTriggers(decision: Decision, creatureId: string, boundary: "start" | "end"): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null) return false;
  if (triggersDueAt(Object.values(encounter.combatants), creatureId, boundary, []).length === 0) return false;
  decision.emit({ kind: "triggersBegan", creatureId, boundary });
  if (nextTrigger(decision)) return true;
  decision.emit({ kind: "triggersFinished" });
  return false;
}

// Asks for the next trigger's roll; false when none is left.
function nextTrigger(decision: Decision): boolean {
  const encounter = activeEncounter(decision);
  const running = encounter?.pendingTriggers;
  if (encounter == null || running == null) return false;
  const [next] = triggersDueAt(Object.values(encounter.combatants), running.creatureId, running.boundary, running.done);
  if (next === undefined) return false;
  const holder = encounter.combatants[next.holderId];
  if (holder === undefined) return false;
  let spec: RollSpec;
  if (next.does.kind === "damage") {
    spec = { kind: "dice", expression: next.does.amount, critical: false };
  } else {
    const lookup = conditionLookup(decision.ctx.rules.content);
    const bias = saveBias(holder, next.does.ability, lookup);
    const d20: D20TestSpec = { mode: resolveRollMode(bias.advantage, bias.disadvantage), modifier: holder.saves[next.does.ability], bonusDice: bonusDiceFor(holder, "save") };
    spec = { kind: "d20Test", spec: d20 };
  }
  const sequence = encounter.sequence + 1;
  const rollId: RollId = `${encounter.id}:roll:${sequence}`;
  const pending: PendingCombatRoll = { purpose: "trigger", holderId: next.holderId, effectId: next.effectId, index: next.index, spec };
  decision.emit({ kind: "triggerRollRequested", holderId: next.holderId, effectId: next.effectId, index: next.index, rollId, pending, sequence });
  decision.request({ kind: "roll", rollId, spec });
  return true;
}

// A trigger's roll arrives: apply it, then go on to the next trigger or resume the turn.
export function recordTriggerRoll(
  decision: Decision,
  pending: Extract<PendingCombatRoll, { purpose: "trigger" }>,
  rollId: RollId,
  result: RollResult,
  resume: (boundary: "start" | "end", creatureId: string) => void,
): Rejection | null {
  const encounter = activeEncounter(decision);
  const running = encounter?.pendingTriggers;
  if (encounter == null || running == null) return { code: "unknownRoll" };
  if (!resultMatchesSpec(result, pending.spec)) return { code: "rollMismatch" };
  const holder = encounter.combatants[pending.holderId];
  const effect = holder?.effects.find((candidate) => candidate.id === pending.effectId);
  const action = effect?.triggers[pending.index]?.does;
  if (holder === undefined || effect === undefined || action === undefined) return { code: "unknownRoll" };

  if (action.kind === "damage" && result.kind === "dice") {
    const amount = Math.max(0, result.roll.total);
    decision.emit({ kind: "triggerRolled", rollId, holderId: holder.id, effectId: effect.id, result, outcome: { kind: "damage", amount } });
    applyDamage(decision, holder, amount, false, action.damageType);
  } else if (action.kind === "saveToEnd" && result.kind === "d20Test") {
    const naturalRule = decision.ctx.rules.houseRules.option(naturalRollsOnChecks);
    const ended = resolveD20Test("savingThrow", result.roll.d20.natural, result.roll.total, action.dc, naturalRule).success;
    decision.emit({ kind: "triggerRolled", rollId, holderId: holder.id, effectId: effect.id, result, outcome: { kind: "save", ended, dc: action.dc } });
    if (ended) decision.emit({ kind: "effectsRemoved", combatantId: holder.id, effectIds: [effect.id], reason: "saved" });
  } else {
    return { code: "rollMismatch" };
  }

  if (nextTrigger(decision)) return null;
  decision.emit({ kind: "triggersFinished" });
  resume(running.boundary, running.creatureId);
  return null;
}
