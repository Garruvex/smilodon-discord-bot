import { assertNever } from "../../core/assert-never.js";
import type { RollId } from "../../core/ids.js";
import type { ActionCost } from "../../combat/combat-events.js";
import {
  areEngaged,
  engagedWith,
  isActive,
  isPresent,
  type Combatant,
  type CombatantId,
  type EncounterState,
  type PendingCheck,
  type PendingCombatRoll,
  type PendingEffectRoll,
  type ResolutionSource,
  type ResolutionState,
  type TargetOutcome,
} from "../../combat/combat-state.js";
import { armorClassOf, attackBias, autoFailsSave, bonusDiceFor, conditionLookup, effectsUsedUpByAttack, hitsAreCritical, saveBias, type ConditionLookup } from "../../effects/effect-queries.js";
import type { EffectInstance } from "../../effects/effect-instance.js";
import type { D20TestRoll } from "../../dice/d20-test.js";
import type { ContentId } from "../../rules/content-id.js";
import { distanceBetween, engagedDistance } from "../../combat/positioning.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { combine, plus } from "../../dice/dice-expression.js";
import { resolveRollMode } from "../../dice/roll.js";
import { classifyRollMoments } from "../../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../../dice/roll-spec.js";
import type { Effect, EffectDuration, ResolutionPlan } from "../../rules/effects.js";
import { criticalHits, naturalRollsOnChecks } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, afterResolution, endIfDecided, isProtected } from "./combat-flow.js";
import { concentrationDc } from "../../magic/spell-rules.js";
import { offerReaction } from "./reactions.js";

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
  const consumedAdvantage: { combatantId: CombatantId; effectIds: readonly string[] }[] = [];
  const lookup = conditionLookup(decision.ctx.rules.content);
  // Targets that fail a saving throw without rolling (an unconscious creature's Strength and Dexterity saves).
  const autoFailed: Record<CombatantId, TargetOutcome> = {};
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
      if (autoFailsSave(target, check.ability, lookup)) {
        autoFailed[targetId] = { landed: true, critical: false };
        continue;
      }
      const dc = actor.spellcasting?.saveDc ?? 10;
      const bias = saveBias(target, check.ability, lookup);
      spec = { mode: resolveRollMode(bias.advantage, bias.disadvantage), modifier: target.saves[check.ability], bonusDice: bonusDiceFor(target, "save") };
      against = dc;
      kind = "save";
    } else {
      const ranged = rangedAttack(source);
      const distance = distanceBetween(encounter, actor.id, target.id) ?? Infinity;
      const longShot = source.kind === "weapon" && source.option.range.kind === "ranged" && distance > source.option.range.normal;
      const mode = attackMode(encounter, actor, target, ranged, longShot, lookup);
      const toHit = source.kind === "weapon" ? source.option.toHit : (actor.spellcasting?.attackBonus ?? 0);
      spec = { mode: mode.mode, modifier: toHit, bonusDice: bonusDiceFor(actor, "attack") };
      against = armorClassOf(target, lookup);
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
    outcomes: plan.check === null ? Object.fromEntries(request.targetIds.map((targetId) => [targetId, { landed: true, critical: false }])) : autoFailed,
    effectRolls: {},
    rolled: {},
    sneakAttack,
  };

  // A new concentration spell ends the previous one.
  if (source.kind === "spell" && decision.ctx.rules.content.get(source.spellId).concentration) {
    if (actor.concentration !== null) endConcentration(decision, actor.id, "newSpell");
  }
  decision.emit({ kind: "resolutionDeclared", resolution, cost: request.cost, pendingRolls, sequence });
  for (const consumed of consumedAdvantage) decision.emit({ kind: "effectsRemoved", ...consumed, reason: "usedUp" });
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
  // A hit its target could still turn into a miss (Shield) waits for its answer.
  if (check.kind === "attack") {
    const target = encounter.combatants[check.targetId];
    const against = target === undefined ? check.against : armorClassOf(target, conditionLookup(decision.ctx.rules.content));
    const outcome = resolveD20Test("attack", roll.d20.natural, roll.total, against, "no-effect");
    if (outcome.success && !outcome.critical && offerReaction(decision, encounter, resolution, rollId, roll, against)) return null;
  }
  return settleCheck(decision, resolution.id, rollId, roll);
}

// A check's dice are in: works out whether it landed (an attack against the armor
// class the target has now, so a reaction can change the answer), records it, and
// goes on to the effects once every check is settled and no reaction is pending.
export function settleCheck(decision: Decision, resolutionId: string, rollId: RollId, roll: D20TestRoll): Rejection | null {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  const check = resolution?.checks[rollId];
  if (encounter == null || resolution == null || resolution.id !== resolutionId || check === undefined) return { code: "unknownRoll" };
  const lookup = conditionLookup(decision.ctx.rules.content);
  const target = encounter.combatants[check.targetId];
  let landed: boolean;
  let critical = false;
  let moments;
  if (check.kind === "attack") {
    const against = target === undefined ? check.against : armorClassOf(target, lookup);
    const outcome = resolveD20Test("attack", roll.d20.natural, roll.total, against, "no-effect");
    landed = outcome.success;
    // A hit on an unconscious creature from within 5 feet is a critical hit.
    const closeCrit = target !== undefined && hitsAreCritical(target, lookup, areEngaged(encounter, resolution.actorId, target.id));
    critical = outcome.critical || (landed && closeCrit);
    moments = classifyRollMoments({ kind: "attack", roll, target: against, naturalRule: "no-effect" });
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
  if (after != null && !waiting && after.reaction == null) proceedToEffects(decision);
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
        const critical = effect.kind === "damage" && anyCritical;
        const spec: RollSpec = {
          kind: "dice",
          expression,
          critical,
          ...(critical && decision.ctx.rules.houseRules.option(criticalHits) === "max-first-die" ? { criticalRule: "max-first-die" as const } : {}),
        };
        rolls[`${encounter.id}:roll:${++sequence}`] = { effectKey: key, targetId: null, spec };
      }
      if (effect.kind === "conditionUnlessSave") {
        for (const targetId of targets) {
          const target = encounter.combatants[effect.target === "self" ? resolution.actorId : targetId];
          if (target === undefined) continue;
          const lookup = conditionLookup(decision.ctx.rules.content);
          if (autoFailsSave(target, effect.ability, lookup)) continue;
          const bias = saveBias(target, effect.ability, lookup);
          const spec: RollSpec = {
            kind: "d20Test",
            spec: { mode: resolveRollMode(bias.advantage, bias.disadvantage), modifier: target.saves[effect.ability], bonusDice: bonusDiceFor(target, "save") },
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
      decision.emit({ kind: "effectApplied", combatantId: recipient.id, effect: conditionInstance(resolution, recipient, effect.condition, key, effect.duration, round) });
      return;
    case "bonusDie": {
      const concentrating = resolution.source.kind === "spell" && decision.ctx.rules.content.get(resolution.source.spellId).concentration;
      const id = `${resolution.id}:${recipient.id}`;
      const spellId = resolution.source.kind === "spell" ? resolution.source.spellId : null;
      decision.emit({
        kind: "effectApplied",
        combatantId: recipient.id,
        effect: {
          id,
          definition: spellId ?? "effect:bonus-die",
          sourceId: resolution.actorId,
          conditions: [],
          modifiers: [{ kind: "bonusDie", die: effect.die, appliesTo: effect.appliesTo, source: spellId ?? id }],
          triggers: [],
          // Ends at the start of the source's turn once its rounds are up.
          clock: effect.duration.kind === "rounds" ? { follows: "source", boundary: "start", untilRound: round + effect.duration.count } : null,
          concentrationId: concentrating ? resolution.id : null,
          stacking: "coexist",
        },
      });
      return;
    }
    case "nextAttackAdvantage":
      // Guiding Bolt: the next attack against the target has advantage, until the end of the source's next turn.
      decision.emit({
        kind: "effectApplied",
        combatantId: recipient.id,
        effect: {
          id: `${resolution.id}:${recipient.id}`,
          definition: resolution.source.kind === "spell" ? resolution.source.spellId : "effect:advantage",
          sourceId: resolution.actorId,
          conditions: [],
          modifiers: [{ kind: "attacksAgainst", mode: "advantage", reach: "any", usesUp: true }],
          triggers: [],
          clock: { follows: "source", boundary: "end", untilRound: round + 1 },
          concentrationId: null,
          stacking: "coexist",
        },
      });
      return;
    case "conditionUnlessSave":
      if (resolution.rolled[`rider:${recipient.id}:${key}`] === 0 || autoFailsSave(recipient, effect.ability, conditionLookup(decision.ctx.rules.content))) {
        decision.emit({ kind: "effectApplied", combatantId: recipient.id, effect: conditionInstance(resolution, recipient, effect.condition, key, null, round) });
      }
      return;
    default:
      assertNever(effect);
  }
}

// A condition as a lasting effect: it does not stack, and ends when its rounds are up (at the start of its source's turn) if it has any.
function conditionInstance(
  resolution: ResolutionState,
  recipient: Combatant,
  condition: ContentId<"condition">,
  key: string,
  duration: EffectDuration | null,
  round: number,
): EffectInstance {
  return {
    id: `${resolution.id}:${recipient.id}:${key}`,
    definition: condition,
    sourceId: resolution.actorId,
    conditions: [condition],
    modifiers: [],
    triggers: [],
    clock: duration?.kind === "rounds" ? { follows: "source", boundary: "start", untilRound: round + duration.count } : null,
    concentrationId: null,
    stacking: "ignore",
  };
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
  requestConcentrationSave(decision, after, concentrationDc(amount));
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
    const effectIds = combatant.effects.flatMap((effect) => (effect.concentrationId === concentration.resolutionId ? [effect.id] : []));
    if (effectIds.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: combatant.id, effectIds, reason: "concentration" });
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
  lookup: ConditionLookup,
): { readonly mode: D20TestSpec["mode"]; readonly consumed: readonly string[] } {
  let advantage = 0;
  let disadvantage = longShot ? 1 : 0;
  const distance = distanceBetween(encounter, attacker.id, target.id) ?? Infinity;
  // What conditions and lasting effects on either creature add (prone, unconscious, dodging, a Guiding Bolt...).
  const bias = attackBias(attacker, target, lookup, distance <= engagedDistance);
  advantage += bias.advantage;
  disadvantage += bias.disadvantage;
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
  return { mode: resolveRollMode(advantage, disadvantage), consumed: effectsUsedUpByAttack(target) };
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
