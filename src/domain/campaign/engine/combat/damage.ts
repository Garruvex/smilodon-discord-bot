// Hit points and concentration: damage and healing, the death and unconscious rules, and what keeps a caster concentrating.
import type { RollId } from "../../core/ids.js";
import { isPresent, type Combatant, type CombatantId, type PendingCombatRoll } from "../../combat/combat-state.js";
import { bonusDiceFor } from "../../effects/effect-queries.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { resultMatchesSpec, type RollResult } from "../../dice/roll-spec.js";
import { naturalRollsOnChecks } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, isProtected } from "./combat-flow.js";
import { concentrationDc } from "../../magic/spell-rules.js";
import { finishResolution } from "./resolution.js";

// 2014 rules: damage that leaves a hero at 0 HP knocks them unconscious;
// leftover damage of at least their HP maximum kills outright; damage while
// at 0 HP is a death-save failure (two on a critical). Monsters die at 0.
// Protected while away (plan §5): the hero stops at 0 HP, stable.
export function applyDamage(decision: Decision, target: Combatant, amount: number, critical: boolean): void {
  if (amount <= 0) return;
  const base = { kind: "combatantHpChanged", combatantId: target.id, change: -amount } as const;
  const protectedHero = isProtected(decision, target);
  if (target.side === "foes") {
    const hp = Math.max(0, target.hp - amount);
    decision.emit({ ...base, hp, condition: hp === 0 ? "dead" : "active", deathSaves: target.deathSaves, cause: "damage" });
  } else if (target.hp === 0) {
    if (protectedHero) return;
    const failures = Math.min(3, target.deathSaves.failures + (critical ? 2 : 1));
    const deathSaves = { successes: target.deathSaves.successes, failures };
    decision.emit({ ...base, hp: 0, condition: failures >= 3 ? "dead" : "unconscious", deathSaves, cause: "damageAtZero" });
  } else if (amount < target.hp) {
    decision.emit({ ...base, hp: target.hp - amount, condition: "active", deathSaves: target.deathSaves, cause: "damage" });
  } else if (protectedHero) {
    decision.emit({ ...base, hp: 0, condition: "stable", deathSaves: { successes: 0, failures: 0 }, cause: "protectedWhileAway" });
  } else {
    const massive = amount - target.hp >= target.maxHp;
    decision.emit({
      ...base,
      hp: 0,
      condition: massive ? "dead" : "unconscious",
      deathSaves: { successes: 0, failures: 0 },
      cause: massive ? "massiveDamage" : "damage",
    });
  }
  const after = activeEncounter(decision)?.combatants[target.id];
  if (after?.concentration == null) return;
  if (after.hp === 0) {
    endConcentration(decision, after.id, "downed");
    return;
  }
  requestConcentrationSave(decision, after, concentrationDc(amount));
}

export function applyHealing(decision: Decision, target: Combatant, amount: number): void {
  if (!isPresent(target) || amount <= 0) return;
  const hp = Math.min(target.maxHp, target.hp + amount);
  decision.emit({
    kind: "combatantHpChanged",
    combatantId: target.id,
    change: hp - target.hp,
    hp,
    condition: "active",
    deathSaves: { successes: 0, failures: 0 },
    cause: "healing",
  });
}

export function requestConcentrationSave(decision: Decision, caster: Combatant, dc: number): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const sequence = encounter.sequence + 1;
  const rollId = `${encounter.id}:roll:${sequence}`;
  const spec: D20TestSpec = { mode: "normal", modifier: caster.saves.con, bonusDice: bonusDiceFor(caster, "save") };
  decision.emit({ kind: "concentrationSaveRequested", combatantId: caster.id, rollId, pending: { purpose: "concentration", combatantId: caster.id, spec, dc }, sequence });
  decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec } });
}

export function recordConcentration(
  decision: Decision,
  pending: Extract<PendingCombatRoll, { purpose: "concentration" }>,
  rollId: RollId,
  result: RollResult,
): Rejection | null {
  if (result.kind !== "d20Test" || !resultMatchesSpec(result, { kind: "d20Test", spec: pending.spec })) return { code: "rollMismatch" };
  const naturalRule = decision.ctx.rules.houseRules.option(naturalRollsOnChecks);
  const kept = resolveD20Test("savingThrow", result.roll.d20.natural, result.roll.total, pending.dc, naturalRule).success;
  decision.emit({ kind: "concentrationSaveRolled", combatantId: pending.combatantId, rollId, roll: result.roll, dc: pending.dc, kept });
  if (!kept) endConcentration(decision, pending.combatantId, "failedSave");
  const encounter = activeEncounter(decision);
  const waiting = Object.values(encounter?.pendingRolls ?? {}).some((roll) => roll.purpose === "concentration");
  if (!waiting && encounter?.resolution != null && encounter.resolution.stage !== "checks") finishResolution(decision);
  return null;
}

// Ends a caster's concentration and every effect that depended on it.
export function endConcentration(
  decision: Decision,
  casterId: CombatantId,
  reason: "newSpell" | "failedSave" | "downed" | "expired",
): void {
  const encounter = activeEncounter(decision);
  const concentration = encounter?.combatants[casterId]?.concentration;
  if (encounter == null || concentration == null) return;
  decision.emit({ kind: "concentrationEnded", combatantId: casterId, reason });
  for (const combatant of Object.values(encounter.combatants)) {
    const effectIds = combatant.effects.flatMap((effect) => (effect.concentrationId === concentration.resolutionId ? [effect.id] : []));
    if (effectIds.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: combatant.id, effectIds, reason: "concentration" });
  }
}
