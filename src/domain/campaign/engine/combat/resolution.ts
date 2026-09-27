// Resolving an action: declaring its plan, the checks and effect rolls it needs, and applying what lands. Damage and concentration are in damage.ts, the attack rules in attack-rules.ts.
import { assertNever } from "../../core/assert-never.js";
import type { RollId } from "../../core/ids.js";
import type { ActionCost } from "../../combat/combat-events.js";
import { areEngaged, isPresent, type Combatant, type CombatantId, type EncounterState, type PendingCheck, type PendingCombatRoll, type PendingEffectRoll, type ResolutionSource, type ResolutionState, type TargetOutcome } from "../../combat/combat-state.js";
import { armorClassOf, autoFailsSave, bonusDiceFor, conditionLookup, hitsAreCritical, saveBias } from "../../effects/effect-queries.js";
import type { EffectInstance } from "../../effects/effect-instance.js";
import type { D20TestRoll } from "../../dice/d20-test.js";
import type { ContentId } from "../../rules/content-id.js";
import { distanceBetween } from "../../combat/positioning.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { combine } from "../../dice/dice-expression.js";
import { resolveRollMode } from "../../dice/roll.js";
import { classifyRollMoments } from "../../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../../dice/roll-spec.js";
import type { Effect, EffectDuration } from "../../rules/effects.js";
import { criticalHits, naturalRollsOnChecks } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, afterResolution, endIfDecided } from "./combat-flow.js";
import { offerReaction } from "./reactions.js";
import { applyDamage, applyHealing, endConcentration, recordConcentration } from "./damage.js";
import { attackMode, effectForKey, planFor, rangedAttack, sneakAttackEligible, sneakDice } from "./attack-rules.js";
export { applyDamage, endConcentration } from "./damage.js";
export { attackMode } from "./attack-rules.js";

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

export function recordCheck(
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

// Works out which effects happen to whom, and asks for the dice they need.
// Damage and healing dice are rolled once per effect and shared by every
// target it applies to (2014 rules for multi-target spells).
export function proceedToEffects(decision: Decision): void {
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

export function recordEffect(decision: Decision, resolution: ResolutionState, rollId: RollId, result: RollResult): Rejection | null {
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

export function applyEffects(decision: Decision): void {
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

export function applyEffect(
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
export function conditionInstance(
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

export function finishResolution(decision: Decision): void {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  if (encounter == null || resolution == null) return;
  decision.emit({ kind: "resolutionFinished", resolutionId: resolution.id });
  decision.request({ kind: "deliver", delivery: { kind: "attackResolved", encounterId: encounter.id, attackId: resolution.id } });
  if (endIfDecided(decision)) return;
  afterResolution(decision, resolution);
}
