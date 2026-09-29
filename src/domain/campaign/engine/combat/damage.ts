// Hit points and concentration: damage and healing, the death and unconscious rules, and what keeps a caster concentrating.
import type { RollId } from "../../core/ids.js";
import { isPresent, type Combatant, type CombatantId, type PendingCombatRoll } from "../../combat/combat-state.js";
import { bonusDiceFor, conditionLookup, effectResistances } from "../../effects/effect-queries.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { resultMatchesSpec, type RollResult } from "../../dice/roll-spec.js";
import { naturalRollsOnChecks } from "../../rules/house-rules.js";
import type { DamageType } from "../../rules/effects.js";
import { damageMultiplier, relentlessEnduranceKey, relentlessRageKey } from "../../rules/traits.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, isProtected } from "./combat-flow.js";
import { concentrationDc } from "../../magic/spell-rules.js";
import { finishResolution } from "./resolution.js";
import { revertWildShape } from "./wild-shape.js";

// 2014 rules: damage that leaves a hero at 0 HP knocks them unconscious;
// leftover damage of at least their HP maximum kills outright; damage while
// at 0 HP is a death-save failure (two on a critical). Monsters die at 0.
// Protected while away (plan §5): the hero stops at 0 HP, stable.
// damageType null: a source with no type to check resistance/immunity/
// vulnerability against (a trigger predates this, or a future non-typed source).
export function applyDamage(decision: Decision, target: Combatant, rolled: number, critical: boolean, damageType: DamageType | null = null): void {
  const traits = [...target.traits, ...effectResistances(target, conditionLookup(decision.ctx.rules.content))];
  const amount = damageType === null ? rolled : Math.floor(rolled * damageMultiplier(traits, damageType));
  if (amount <= 0) return;
  // A Wild Shaped druid whose beast form drops to 0 HP reverts, and the damage left over falls on them.
  if (target.wildShapeOriginal !== null && amount >= target.hp) {
    revertWildShape(decision, target);
    const restored = activeEncounter(decision)?.combatants[target.id];
    if (restored !== undefined && amount > target.hp) applyDamage(decision, restored, amount - target.hp, critical);
    return;
  }
  // A regenerating monster hit by the damage that stops it does not regenerate at its next turn.
  if (damageType !== null && !target.regenBlocked && target.traits.some((trait) => trait.kind === "regeneration" && trait.blockedBy.includes(damageType))) {
    decision.emit({ kind: "monsterStateChanged", combatantId: target.id, regenBlocked: true });
  }
  // Temporary hit points take the damage first; only what is left reaches the real ones.
  const temp = target.tempHp ?? 0;
  const absorbed = Math.min(temp, amount);
  const remaining = amount - absorbed;
  const tempLeft = absorbed > 0 ? { tempHp: temp - absorbed } : {};
  if (remaining === 0) {
    decision.emit({ kind: "combatantHpChanged", combatantId: target.id, change: 0, hp: target.hp, condition: target.condition, deathSaves: target.deathSaves, cause: "damage", ...tempLeft });
    const soaked = activeEncounter(decision)?.combatants[target.id];
    if (soaked?.concentration != null) requestConcentrationSave(decision, soaked, concentrationDc(amount));
    return;
  }
  const base = { kind: "combatantHpChanged", combatantId: target.id, change: -remaining, ...tempLeft } as const;
  const protectedHero = isProtected(decision, target);
  const through = remaining;
  // A conjured creature (a party-side monster) drops at 0 like a foe.
  if (target.side === "foes" || target.source.kind !== "hero") {
    const hp = Math.max(0, target.hp - through);
    decision.emit({ ...base, hp, condition: hp === 0 ? "dead" : "active", deathSaves: target.deathSaves, cause: "damage" });
  } else if (target.hp === 0) {
    if (protectedHero) return;
    const failures = Math.min(3, target.deathSaves.failures + (critical ? 2 : 1));
    const deathSaves = { successes: target.deathSaves.successes, failures };
    decision.emit({ ...base, hp: 0, condition: failures >= 3 ? "dead" : "unconscious", deathSaves, cause: "damageAtZero" });
  } else if (through < target.hp) {
    decision.emit({ ...base, hp: target.hp - through, condition: "active", deathSaves: target.deathSaves, cause: "damage" });
  } else if (protectedHero) {
    decision.emit({ ...base, hp: 0, condition: "stable", deathSaves: { successes: 0, failures: 0 }, cause: "protectedWhileAway" });
  } else {
    const massive = through - target.hp >= target.maxHp;
    // Relentless Endurance: once per long rest, not killed outright, drop to 1 HP instead of 0.
    if (!massive && (target.resources.featureUses[relentlessEnduranceKey] ?? 0) > 0) {
      decision.emit({ kind: "monsterStateChanged", combatantId: target.id, relentlessSpent: true });
      decision.emit({ ...base, change: 1 - target.hp, hp: 1, condition: "active", deathSaves: target.deathSaves, cause: "damage" });
    } else if (!massive && (target.resources.featureUses[relentlessRageKey] ?? 0) > 0 && target.effects.some((effect) => effect.definition === "feature:rage")) {
      // Relentless Rage: a raging barbarian dropped to 0 stays up at twice their level in hit points, once per long rest
      // (the SRD's Constitution save is played as a success).
      const hp = Math.min(target.maxHp, target.level * 2);
      decision.emit({ kind: "monsterStateChanged", combatantId: target.id, relentlessRageSpent: true });
      decision.emit({ ...base, change: hp - target.hp, hp, condition: "active", deathSaves: target.deathSaves, cause: "damage" });
    } else decision.emit({
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

// Temporary hit points replace a smaller pool and are lost when a larger one is already held.
export function applyTempHp(decision: Decision, target: Combatant, amount: number): void {
  if (!isPresent(target) || amount <= (target.tempHp ?? 0)) return;
  decision.emit({ kind: "combatantHpChanged", combatantId: target.id, change: 0, hp: target.hp, tempHp: amount, condition: target.condition, deathSaves: target.deathSaves, cause: "healing" });
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
