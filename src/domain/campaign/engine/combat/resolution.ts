import { assertNever } from "../../core/assert-never.js";
import type { RollId } from "../../core/ids.js";
import type { ActionCost } from "../../combat/combat-events.js";
import {
  areEngaged,
  bonusDiceFor,
  engagedWith,
  hasCondition,
  isActive,
  isDowned,
  isPresent,
  type Combatant,
  type CombatantId,
  type EncounterState,
  type PendingCheck,
  type PendingCombatRoll,
  type PendingEffectRoll,
  type ResolutionSource,
  type ResolutionState,
} from "../../combat/combat-state.js";
import { distanceBetween, engagedDistance } from "../../combat/positioning.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { combine, plus } from "../../dice/dice-expression.js";
import { resolveRollMode } from "../../dice/roll.js";
import { classifyRollMoments } from "../../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../../dice/roll-spec.js";
import type { Effect, ResolutionPlan } from "../../rules/effects.js";
import { naturalRollsOnChecks } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, afterResolution, endIfDecided, isProtected } from "./combat-flow.js";

const prone = "condition:prone";
// Both give disadvantage on the creature's attack rolls (Frightened's
// line-of-sight and movement limits are not modeled).
const crippling = ["condition:poisoned", "condition:frightened"] as const;

export interface DeclareRequest {
  readonly actor: Combatant;
  readonly source: ResolutionSource;
  readonly targetIds: readonly CombatantId[];
  readonly purpose: "action" | "opportunity";
  readonly cost: ActionCost;
}

// Starts any action: a weapon attack, a spell, or a feature. Callers have
// already checked legality (turn, budget, range, targets); this builds the
// plan, fixes every roll's spec, spends the cost, and asks for the rolls.
export function declareResolution(decision: Decision, request: DeclareRequest): Rejection | null {
  const encounter = activeEncounter(decision);
  if (encounter === null) return { code: "notInCombat" };
  const { actor, source } = request;
  const plan = planFor(decision, actor, source);
  if (plan === null) return { code: "invalidTarget" };

  let sequence = encounter.sequence;
  const id = `${encounter.id}:act:${++sequence}`;
  const checks: Record<RollId, PendingCheck> = {};
  const pendingRolls: Record<RollId, PendingCombatRoll> = {};
  const consumedAdvantage: { combatantId: CombatantId; effectIds: string[] }[] = [];
  let sneakAttack = false;

  for (const targetId of request.targetIds) {
    const target = encounter.combatants[targetId];
    if (target === undefined) return { code: "invalidTarget" };
    const check = plan.check;
    if (check === null) continue;
    let spec: D20TestSpec;
    let against: number;
    let kind: PendingCheck["kind"];
    if (check.kind === "savingThrow") {
      const dc = actor.spellcasting?.saveDc ?? 10;
      spec = { mode: "normal", modifier: target.saves[check.ability], bonusDice: bonusDiceFor(target, "save") };
      against = dc;
      kind = "save";
    } else {
      const ranged = rangedAttack(source);
      const distance = distanceBetween(encounter, actor.id, target.id) ?? Infinity;
      const longShot = source.kind === "weapon" && source.option.range.kind === "ranged" && distance > source.option.range.normal;
      const mode = attackMode(encounter, actor, target, ranged, longShot);
      const toHit = source.kind === "weapon" ? source.option.toHit : (actor.spellcasting?.attackBonus ?? 0);
      spec = { mode: mode.mode, modifier: toHit, bonusDice: bonusDiceFor(actor, "attack") };
      against = target.armorClass;
      kind = "attack";
      if (mode.consumed.length > 0) consumedAdvantage.push({ combatantId: target.id, effectIds: mode.consumed });
      if (source.kind === "weapon" && sneakAttackEligible(encounter, actor, target, source.option.finesse, mode.mode)) sneakAttack = true;
    }
    const rollId = `${encounter.id}:roll:${++sequence}`;
    checks[rollId] = { targetId, kind, spec, against };
    pendingRolls[rollId] = { purpose: "check", resolutionId: id };
  }

  const resolution: ResolutionState = {
    id,
    actorId: actor.id,
    source,
    targetIds: request.targetIds,
    plan,
    purpose: request.purpose,
    stage: "checks",
    checks,
    outcomes: plan.check === null ? Object.fromEntries(request.targetIds.map((targetId) => [targetId, { landed: true, critical: false }])) : {},
    effectRolls: {},
    rolled: {},
    sneakAttack,
  };

  // A new concentration spell ends the previous one.
  if (source.kind === "spell" && decision.ctx.rules.content.get(source.spellId).concentration) {
    if (actor.concentration !== null) endConcentration(decision, actor.id, "newSpell");
  }
  decision.emit({ kind: "resolutionDeclared", resolution, cost: request.cost, pendingRolls, sequence });
  for (const consumed of consumedAdvantage) decision.emit({ kind: "effectsRemoved", ...consumed });
  if (source.kind === "spell" && decision.ctx.rules.content.get(source.spellId).concentration) {
    decision.emit({ kind: "concentrationStarted", combatantId: actor.id, concentration: { resolutionId: id, spellId: source.spellId } });
  }
  for (const [rollId, check] of Object.entries(checks)) decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec: check.spec } });
  if (Object.keys(checks).length === 0) proceedToEffects(decision);
  return null;
}

export function recordResolutionRoll(decision: Decision, pending: PendingCombatRoll, rollId: RollId, result: RollResult): Rejection | null {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  if (encounter == null || resolution == null) return { code: "unknownRoll" };
  if (pending.purpose === "check") return recordCheck(decision, encounter, resolution, rollId, result);
  if (pending.purpose === "effect") return recordEffect(decision, resolution, rollId, result);
  if (pending.purpose === "concentration") return recordConcentration(decision, pending, rollId, result);
  return { code: "unknownRoll" };
}

// ------------------------------------------------------------- Checks

function recordCheck(
  decision: Decision,
  encounter: EncounterState,
  resolution: ResolutionState,
  rollId: RollId,
  result: RollResult,
): Rejection | null {
  const check = resolution.checks[rollId];
  if (check === undefined) return { code: "unknownRoll" };
  if (result.kind !== "d20Test" || !resultMatchesSpec(result, { kind: "d20Test", spec: check.spec })) return { code: "rollMismatch" };
  const roll = result.roll;
  const target = encounter.combatants[check.targetId];
  let landed: boolean;
  let critical = false;
  let moments;
  if (check.kind === "attack") {
    const outcome = resolveD20Test("attack", roll.d20.natural, roll.total, check.against, "no-effect");
    landed = outcome.success;
    // A hit on an unconscious creature from within 5 feet is a critical hit.
    const closeOnDowned = target !== undefined && isDowned(target) && areEngaged(encounter, resolution.actorId, target.id);
    critical = outcome.critical || (landed && closeOnDowned);
    moments = classifyRollMoments({ kind: "attack", roll, target: check.against, naturalRule: "no-effect" });
  } else {
    const naturalRule = decision.ctx.rules.houseRules.option(naturalRollsOnChecks);
    const saved = resolveD20Test("savingThrow", roll.d20.natural, roll.total, check.against, naturalRule).success;
    landed = !saved;
    moments = classifyRollMoments({ kind: "savingThrow", roll, target: check.against, naturalRule });
  }
  decision.emit({ kind: "checkRolled", resolutionId: resolution.id, rollId, targetId: check.targetId, roll, landed, critical, moments });
  decision.request({ kind: "deliver", delivery: { kind: "attackRolled", encounterId: encounter.id, attackId: resolution.id } });
  const after = activeEncounter(decision)?.resolution;
  const waiting = Object.values(activeEncounter(decision)?.pendingRolls ?? {}).some(
    (pending) => pending.purpose === "check" && pending.resolutionId === resolution.id,
  );
  if (after != null && !waiting) proceedToEffects(decision);
  return null;
}

// ------------------------------------------------------------- Effects

// Works out which effects happen to whom, and asks for the dice they need.
// Damage and healing dice are rolled once per effect and shared by every
// target it applies to (2014 rules for multi-target spells).
function proceedToEffects(decision: Decision): void {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  if (encounter == null || resolution == null) return;
  let sequence = encounter.sequence;
  const rolls: Record<RollId, PendingEffectRoll> = {};
  const anyCritical = Object.values(resolution.outcomes).some((outcome) => outcome.landed && outcome.critical);
  let sneakAdded = false;

  for (const [listName, effects] of [["land", resolution.plan.onLand], ["avoid", resolution.plan.onAvoid]] as const) {
    const targets = resolution.targetIds.filter((targetId) => (resolution.outcomes[targetId]?.landed ?? false) === (listName === "land"));
    if (targets.length === 0) continue;
    effects.forEach((effect, index) => {
      const key = `${listName}:${index}`;
      if (effect.kind === "damage" || effect.kind === "heal") {
        let expression = effect.amount;
        if (effect.kind === "damage" && listName === "land" && resolution.sneakAttack && !sneakAdded) {
          const sneak = sneakDice(encounter.combatants[resolution.actorId]);
          if (sneak !== null) {
            expression = combine(expression, sneak);
            sneakAdded = true;
          }
        }
        const spec: RollSpec = { kind: "dice", expression, critical: effect.kind === "damage" && anyCritical };
        rolls[`${encounter.id}:roll:${++sequence}`] = { effectKey: key, targetId: null, spec };
      }
      if (effect.kind === "conditionUnlessSave") {
        for (const targetId of targets) {
          const target = encounter.combatants[effect.target === "self" ? resolution.actorId : targetId];
          if (target === undefined) continue;
          const spec: RollSpec = {
            kind: "d20Test",
            spec: { mode: "normal", modifier: target.saves[effect.ability], bonusDice: bonusDiceFor(target, "save") },
          };
          rolls[`${encounter.id}:roll:${++sequence}`] = { effectKey: `rider:${target.id}:${key}`, targetId: target.id, spec };
        }
      }
    });
  }
  if (Object.keys(rolls).length === 0) {
    applyEffects(decision);
    return;
  }
  decision.emit({ kind: "effectRollsRequested", resolutionId: resolution.id, rolls, sequence });
  if (sneakAdded) decision.emit({ kind: "sneakAttackUsed", combatantId: resolution.actorId });
  for (const [rollId, roll] of Object.entries(rolls)) decision.request({ kind: "roll", rollId, spec: roll.spec });
}

function recordEffect(decision: Decision, resolution: ResolutionState, rollId: RollId, result: RollResult): Rejection | null {
  const pending = resolution.effectRolls[rollId];
  if (pending === undefined) return { code: "unknownRoll" };
  if (!resultMatchesSpec(result, pending.spec)) return { code: "rollMismatch" };
  let value: number;
  if (result.kind === "dice") {
    value = Math.max(0, result.roll.total);
  } else {
    const effect = effectForKey(resolution.plan, pending.effectKey);
    const dc = effect?.kind === "conditionUnlessSave" ? effect.dc : 10;
    const naturalRule = decision.ctx.rules.houseRules.option(naturalRollsOnChecks);
    value = resolveD20Test("savingThrow", result.roll.d20.natural, result.roll.total, dc, naturalRule).success ? 1 : 0;
  }
  decision.emit({ kind: "effectRolled", resolutionId: resolution.id, rollId, effectKey: pending.effectKey, result, value });
  const waiting = Object.values(activeEncounter(decision)?.pendingRolls ?? {}).some(
    (roll) => roll.purpose === "effect" && roll.resolutionId === resolution.id,
  );
  if (!waiting) applyEffects(decision);
  return null;
}

function applyEffects(decision: Decision): void {
  const resolution = activeEncounter(decision)?.resolution;
  if (resolution == null) return;
  for (const targetId of resolution.targetIds) {
    const outcome = resolution.outcomes[targetId];
    const listName = outcome?.landed === true ? "land" : "avoid";
    const effects = listName === "land" ? resolution.plan.onLand : resolution.plan.onAvoid;
    effects.forEach((effect, index) => {
      const key = `${listName}:${index}`;
      const encounter = activeEncounter(decision);
      if (encounter === null) return;
      const recipientId = effect.target === "self" ? resolution.actorId : targetId;
      const recipient = encounter.combatants[recipientId];
      if (recipient === undefined || !isPresent(recipient)) return;
      applyEffect(decision, resolution, effect, key, recipient, outcome?.critical ?? false);
    });
  }
  const waiting = Object.values(activeEncounter(decision)?.pendingRolls ?? {}).some((roll) => roll.purpose === "concentration");
  if (!waiting) finishResolution(decision);
}

function applyEffect(
  decision: Decision,
  resolution: ResolutionState,
  effect: Effect,
  key: string,
  recipient: Combatant,
  critical: boolean,
): void {
  const round = activeEncounter(decision)?.round ?? 0;
  switch (effect.kind) {
    case "damage":
      applyDamage(decision, recipient, resolution.rolled[key] ?? 0, critical);
      return;
    case "heal":
      applyHealing(decision, recipient, resolution.rolled[key] ?? 0);
      return;
    case "applyCondition":
      decision.emit({ kind: "conditionAdded", combatantId: recipient.id, condition: effect.condition });
      return;
    case "bonusDie": {
      const concentrating = resolution.source.kind === "spell" && decision.ctx.rules.content.get(resolution.source.spellId).concentration;
      decision.emit({
        kind: "effectAdded",
        combatantId: recipient.id,
        effect: {
          kind: "bonusDie",
          id: `${resolution.id}:${recipient.id}`,
          sourceId: resolution.actorId,
          spellId: resolution.source.kind === "spell" ? resolution.source.spellId : null,
          die: effect.die,
          appliesTo: effect.appliesTo,
          expiresAtRound: effect.duration.kind === "rounds" ? round + effect.duration.count : null,
          concentrationId: concentrating ? resolution.id : null,
        },
      });
      return;
    }
    case "nextAttackAdvantage":
      decision.emit({
        kind: "effectAdded",
        combatantId: recipient.id,
        effect: { kind: "attackedWithAdvantage", id: `${resolution.id}:${recipient.id}`, sourceId: resolution.actorId, castRound: round },
      });
      return;
    case "conditionUnlessSave":
      if (resolution.rolled[`rider:${recipient.id}:${key}`] === 0) {
        decision.emit({ kind: "conditionAdded", combatantId: recipient.id, condition: effect.condition });
      }
      return;
    default:
      assertNever(effect);
  }
}

function finishResolution(decision: Decision): void {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  if (encounter == null || resolution == null) return;
  decision.emit({ kind: "resolutionFinished", resolutionId: resolution.id });
  decision.request({ kind: "deliver", delivery: { kind: "attackResolved", encounterId: encounter.id, attackId: resolution.id } });
  if (endIfDecided(decision)) return;
  afterResolution(decision, resolution);
}

// ------------------------------------------------------------- HP

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
  requestConcentrationSave(decision, after, Math.max(10, Math.floor(amount / 2)));
}

function applyHealing(decision: Decision, target: Combatant, amount: number): void {
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

// ------------------------------------------------------------- Concentration

function requestConcentrationSave(decision: Decision, caster: Combatant, dc: number): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const sequence = encounter.sequence + 1;
  const rollId = `${encounter.id}:roll:${sequence}`;
  const spec: D20TestSpec = { mode: "normal", modifier: caster.saves.con, bonusDice: bonusDiceFor(caster, "save") };
  decision.emit({ kind: "concentrationSaveRequested", combatantId: caster.id, rollId, pending: { purpose: "concentration", combatantId: caster.id, spec, dc }, sequence });
  decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec } });
}

function recordConcentration(
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
    const effectIds = combatant.effects.flatMap((effect) =>
      effect.kind === "bonusDie" && effect.concentrationId === concentration.resolutionId ? [effect.id] : [],
    );
    if (effectIds.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: combatant.id, effectIds });
  }
}

// ------------------------------------------------------------- Rules helpers

function planFor(decision: Decision, actor: Combatant, source: ResolutionSource): ResolutionPlan | null {
  const content = decision.ctx.rules.content;
  switch (source.kind) {
    case "weapon":
      return {
        check: { kind: "weaponAttack" },
        onLand: [{ kind: "damage", target: "target", amount: source.option.damage, damageType: source.option.damageType }, ...source.option.onHit],
        onAvoid: [],
      };
    case "spell": {
      const spell = content.get(source.spellId);
      const plan = spell.plan({ slotLevel: source.slotLevel, casterLevel: actor.level, spellcastingModifier: actor.spellcasting?.modifier ?? 0 });
      // Disciple of Life and similar: extra healing from leveled spells.
      const bonus = source.slotLevel > 0 ? healingBonus(actor, source.slotLevel) : 0;
      if (bonus === 0) return plan;
      const boost = (effect: Effect): Effect => (effect.kind === "heal" ? { ...effect, amount: plus(effect.amount, bonus) } : effect);
      return { ...plan, onLand: plan.onLand.map(boost), onAvoid: plan.onAvoid.map(boost) };
    }
    case "feature": {
      const feature = content.get(source.featureId);
      return feature.action?.plan({ level: actor.level }) ?? null;
    }
    default:
      return assertNever(source);
  }
}

function healingBonus(actor: Combatant, spellLevel: number): number {
  return actor.traits.reduce((sum, trait) => sum + (trait.kind === "healingBonus" ? trait.flat + trait.perSpellLevel * spellLevel : 0), 0);
}

function rangedAttack(source: ResolutionSource): boolean {
  if (source.kind === "weapon") return source.option.range.kind === "ranged";
  return true;
}

// Advantage and disadvantage on an attack (2014 rules), and any "next
// attack has advantage" effects the attack uses up.
export function attackMode(
  encounter: EncounterState,
  attacker: Combatant,
  target: Combatant,
  ranged: boolean,
  longShot: boolean,
): { readonly mode: D20TestSpec["mode"]; readonly consumed: string[] } {
  let advantage = 0;
  let disadvantage = longShot ? 1 : 0;
  const distance = distanceBetween(encounter, attacker.id, target.id) ?? Infinity;
  const within5 = distance <= engagedDistance;
  if (target.dodging && isActive(target)) disadvantage += 1;
  // Unconscious: attacks have advantage. Prone (and unconscious creatures are
  // prone): advantage from within 5 feet, disadvantage from farther away.
  if (isDowned(target)) advantage += 1;
  if (isDowned(target) || hasCondition(target, prone)) {
    if (within5) advantage += 1;
    else disadvantage += 1;
  }
  if (hasCondition(attacker, prone)) disadvantage += 1;
  if (crippling.some((condition) => hasCondition(attacker, condition))) disadvantage += 1;
  if (ranged) {
    const threatened = engagedWith(encounter, attacker.id).some((other) => other.side !== attacker.side && isActive(other));
    if (threatened) disadvantage += 1;
  }
  for (const trait of attacker.traits) {
    if (trait.kind !== "packTactics") continue;
    const allyEngaged = engagedWith(encounter, target.id).some(
      (other) => other.side === attacker.side && other.id !== attacker.id && isActive(other),
    );
    if (allyEngaged) advantage += 1;
  }
  const consumed = target.effects.flatMap((effect) => (effect.kind === "attackedWithAdvantage" ? [effect.id] : []));
  if (consumed.length > 0) advantage += 1;
  return { mode: resolveRollMode(advantage, disadvantage), consumed: consumed.slice(0, 1) };
}

// Sneak Attack (2014): once per turn, with a finesse or ranged weapon, when
// the attack has advantage, or an ally is next to the target and the attack
// does not have disadvantage.
function sneakAttackEligible(
  encounter: EncounterState,
  attacker: Combatant,
  target: Combatant,
  finesse: boolean,
  mode: D20TestSpec["mode"],
): boolean {
  if (!finesse || attacker.sneakAttackUsed || sneakDice(attacker) === null) return false;
  if (mode === "advantage") return true;
  if (mode === "disadvantage") return false;
  return engagedWith(encounter, target.id).some((other) => other.side === attacker.side && other.id !== attacker.id && isActive(other));
}

function sneakDice(attacker: Combatant | undefined): ReturnType<typeof combine> | null {
  for (const trait of attacker?.traits ?? []) if (trait.kind === "sneakAttack") return trait.dice;
  return null;
}

function effectForKey(plan: ResolutionPlan, key: string): Effect | undefined {
  const [, listName, index] = /^(?:rider:[^:]+:)?(land|avoid):(\d+)$/.exec(key) ?? [];
  const list = listName === "land" ? plan.onLand : listName === "avoid" ? plan.onAvoid : [];
  return list[Number(index)];
}
