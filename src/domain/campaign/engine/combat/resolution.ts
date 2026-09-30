// Resolving an action: declaring its plan, the checks and effect rolls it needs, and applying what lands. Damage and concentration are in damage.ts, the attack rules in attack-rules.ts.
import { assertNever } from "../../core/assert-never.js";
import type { RollId } from "../../core/ids.js";
import { abilityModifier } from "../../character/character-sheet.js";
import type { ActionCost } from "../../combat/combat-events.js";
import { areEngaged, isPresent, type Combatant, type CombatantId, type EncounterState, type PendingCheck, type PendingCombatRoll, type PendingEffectRoll, type ResolutionSource, type ResolutionState, type TargetOutcome } from "../../combat/combat-state.js";
import { armorClassOf, attackBonusOf, autoFailsSave, bonusDiceFor, conditionLookup, hitsAreCritical, modifiersOf, saveBias } from "../../effects/effect-queries.js";
import type { EffectInstance } from "../../effects/effect-instance.js";
import type { D20TestRoll } from "../../dice/d20-test.js";
import type { SealedContent } from "../../rules/content-registry.js";
import type { ContentId } from "../../rules/content-id.js";
import { monsterAttackOptions, monsterCombatant } from "../../combat/combatant-profile.js";
import { distanceBetween, shortestPath } from "../../combat/positioning.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { combine, dice, flat } from "../../dice/dice-expression.js";
import { resolveRollMode } from "../../dice/roll.js";
import { classifyRollMoments } from "../../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult, type RollSpec } from "../../dice/roll-spec.js";
import type { Effect, EffectDuration } from "../../rules/effects.js";
import { criticalHits, naturalRollsOnChecks } from "../../rules/house-rules.js";
import { creatureTypeOf, critThreshold, hasSaveAdvantage, indomitableKey, innateUseKey, isImmuneToCondition, legendaryResistanceKey } from "../../rules/traits.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, afterResolution, endIfDecided } from "./combat-flow.js";
import { offerCounterspell, offerReaction, offerRetort } from "./reactions.js";
import { offerSmite } from "./smite.js";
import { applyDamage, applyHealing, applyTempHp, endConcentration, recordConcentration } from "./damage.js";
import { auraBonusFor, colossusSlayerEligible, coverBonus, attackMode, effectForKey, planFor, protectorFor, rangedAttack, saveContextOf, sneakAttackEligible, sneakDice } from "./attack-rules.js";
export { applyDamage, endConcentration } from "./damage.js";
export { attackMode } from "./attack-rules.js";

export interface DeclareRequest {
  readonly actor: Combatant;
  readonly source: ResolutionSource;
  readonly targetIds: readonly CombatantId[];
  readonly purpose: "action" | "opportunity" | "legendary" | "reaction";
  // A reaction cast in the middle of another resolution, which carries on once this one is done.
  readonly resumes?: ResolutionState;
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
  const protectors = new Set<CombatantId>();

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
      const dc = source.kind === "area" ? source.area.dc : ((source.kind === "spell" ? actor.spellcasting?.saveDcs?.[source.spellId] : undefined) ?? actor.spellcasting?.saveDc ?? 10);
      const bias = saveBias(target, check.ability, lookup);
      const racial = hasSaveAdvantage(target.traits, check.ability, saveContextOf(plan, source)) ? 1 : 0;
      // Heightened Spell: the first target saves at disadvantage.
      const heightened = source.kind === "spell" && source.metamagic === "heightened" && targetId === request.targetIds[0] ? 1 : 0;
      spec = { mode: resolveRollMode(bias.advantage + racial, bias.disadvantage + heightened), modifier: target.saves[check.ability] + auraBonusFor(encounter, target) + (check.ability === "dex" ? coverBonus(encounter, actor.id, target) : 0), bonusDice: bonusDiceFor(target, "save") };
      against = dc;
      kind = "save";
    } else {
      const ranged = rangedAttack(source);
      const distance = distanceBetween(encounter, actor.id, target.id) ?? Infinity;
      const longShot = source.kind === "weapon" && source.option.range.kind === "ranged" && distance > source.option.range.normal;
      const attackModeBefore = attackMode(encounter, actor, target, ranged, longShot, lookup);
      // Protection: a neighbor's reaction gives the attack disadvantage (one reaction covers the whole action).
      const protector = source.kind === "weapon" ? protectorFor(encounter, target, lookup) : undefined;
      const guarded = protector !== undefined && !protectors.has(protector.id);
      if (guarded) protectors.add(protector.id);
      const mode = guarded ? { ...attackModeBefore, mode: attackModeBefore.mode === "advantage" ? ("normal" as const) : ("disadvantage" as const) } : attackModeBefore;
      if (guarded) decision.emit({ kind: "uncannyDodgeUsed", combatantId: protector.id });
      const toHit = (source.kind === "weapon" ? source.option.toHit : (actor.spellcasting?.attackBonus ?? 0)) + attackBonusOf(actor, lookup);
      spec = { mode: mode.mode, modifier: toHit, bonusDice: bonusDiceFor(actor, "attack") };
      against = armorClassOf(target, lookup) + coverBonus(encounter, actor.id, target);
      kind = "attack";
      if (mode.consumed.length > 0) consumedAdvantage.push({ combatantId: target.id, effectIds: mode.consumed });
      if (source.kind === "weapon" && (sneakAttackEligible(encounter, actor, target, source.option.finesse, mode.mode) || colossusSlayerEligible(actor, target))) sneakAttack = true;
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
    ...(request.resumes === undefined ? {} : { resumes: request.resumes }),
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
  // A hero may counter a foe's spell before anything is rolled for it.
  if (offerCounterspell(decision, activeEncounter(decision) ?? encounter, resolution)) return null;
  startResolution(decision);
  return null;
}

// Asks for the rolls a declared resolution is waiting on (or goes straight on to its effects when it needs none).
export function startResolution(decision: Decision): void {
  const resolution = activeEncounter(decision)?.resolution;
  if (resolution == null) return;
  for (const [rollId, check] of Object.entries(resolution.checks)) decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec: check.spec } });
  if (Object.keys(resolution.checks).length === 0) proceedToEffects(decision);
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
  if (rerollIfLucky(decision, encounter, resolution, rollId, check, roll)) return null;
  // A hit its target could still turn into a miss (Shield) waits for its answer.
  if (check.kind === "attack") {
    const target = encounter.combatants[check.targetId];
    const attacker = encounter.combatants[resolution.actorId];
    const against = target === undefined ? check.against : armorClassOf(target, conditionLookup(decision.ctx.rules.content));
    const outcome = resolveD20Test("attack", roll.d20.natural, roll.total, against, "no-effect", critThreshold(attacker?.traits ?? []));
    if (outcome.success && !outcome.critical && offerReaction(decision, encounter, resolution, rollId, roll, against)) return null;
  }
  return settleCheck(decision, resolution.id, rollId, roll);
}

// Halfling Lucky (a natural 1) and Indomitable (a failed save) throw the roll away and make it again with a new
// roll ID; the new roll is final. Returns true when a new roll was requested.
function rerollIfLucky(decision: Decision, encounter: EncounterState, resolution: ResolutionState, rollId: RollId, check: PendingCheck, roll: D20TestRoll): boolean {
  if ((resolution.rerolled ?? []).includes(rollId)) return false;
  const roller = encounter.combatants[check.kind === "attack" ? resolution.actorId : check.targetId];
  if (roller === undefined) return false;
  const lucky = roll.d20.natural === 1 && roller.traits.some((trait) => trait.kind === "lucky");
  const naturalRule = decision.ctx.rules.houseRules.option(naturalRollsOnChecks);
  const failedSave = check.kind === "save" && !resolveD20Test("savingThrow", roll.d20.natural, roll.total, check.against, naturalRule).success;
  const indomitable = failedSave && roller.traits.some((trait) => trait.kind === "indomitable") && (roller.resources.featureUses[indomitableKey] ?? 0) > 0;
  if (!lucky && !indomitable) return false;
  const newId = `${rollId}:again`;
  if (!lucky) decision.emit({ kind: "monsterStateChanged", combatantId: roller.id, indomitableSpent: true });
  decision.emit({ kind: "checkRerolled", resolutionId: resolution.id, oldRollId: rollId, rollId: newId, reason: lucky ? "lucky" : "indomitable" });
  decision.request({ kind: "roll", rollId: newId, spec: { kind: "d20Test", spec: check.spec } });
  return true;
}

// A check's dice are in: works out whether it landed (an attack against the armor
// class the target has now, so a reaction can change the answer), records it, and
// goes on to the effects once every check is settled and no reaction is pending.
export function settleCheck(decision: Decision, resolutionId: string, rollId: RollId, rolled: D20TestRoll): Rejection | null {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  const check = resolution?.checks[rollId];
  if (encounter == null || resolution == null || resolution.id !== resolutionId || check === undefined) return { code: "unknownRoll" };
  let roll = rolled;
  const lookup = conditionLookup(decision.ctx.rules.content);
  const target = encounter.combatants[check.targetId];
  let landed: boolean;
  let critical = false;
  let moments;
  if (check.kind === "attack") {
    const attacker = encounter.combatants[resolution.actorId];
    const against = target === undefined ? check.against : armorClassOf(target, lookup) + coverBonus(encounter, resolution.actorId, target);
    const outcome = resolveD20Test("attack", roll.d20.natural, roll.total, against, "no-effect", critThreshold(attacker?.traits ?? []));
    landed = outcome.success;
    // A hit on an unconscious creature from within 5 feet is a critical hit.
    const closeCrit = target !== undefined && hitsAreCritical(target, lookup, areEngaged(encounter, resolution.actorId, target.id));
    critical = outcome.critical || (landed && closeCrit);
    // Stroke of Luck: a miss becomes a hit, once a short rest.
    const lucky = !landed && attacker !== undefined && attacker.traits.some((trait) => trait.kind === "strokeOfLuck") && (attacker.resources.featureUses["feature:stroke-of-luck"] ?? 0) > 0;
    if (lucky) {
      landed = true;
      decision.emit({ kind: "monsterStateChanged", combatantId: resolution.actorId, featureSpent: "feature:stroke-of-luck" });
    }
    const cut = landed && !outcome.critical && !lucky ? cuttingWords(decision, encounter, resolution.actorId, roll.total, against) : 0;
    if (cut > 0) {
      landed = false;
      roll = { ...roll, total: roll.total - cut };
    }
    moments = classifyRollMoments({ kind: "attack", roll, target: against, naturalRule: "no-effect" });
  } else {
    const naturalRule = decision.ctx.rules.houseRules.option(naturalRollsOnChecks);
    let saved = resolveD20Test("savingThrow", roll.d20.natural, roll.total, check.against, naturalRule).success;
    // Legendary Resistance: a monster that would fail chooses to succeed instead.
    if (!saved && target !== undefined && (target.resources.featureUses[legendaryResistanceKey] ?? 0) > 0) {
      decision.emit({ kind: "monsterStateChanged", combatantId: target.id, legendaryResistanceSpent: true });
      saved = true;
    }
    landed = !saved;
    moments = classifyRollMoments({ kind: "savingThrow", roll, target: check.against, naturalRule });
  }
  decision.emit({ kind: "checkRolled", resolutionId: resolution.id, rollId, targetId: check.targetId, roll, landed, critical, moments });
  decision.request({ kind: "deliver", delivery: { kind: "attackRolled", encounterId: encounter.id, attackId: resolution.id } });
  const after = activeEncounter(decision)?.resolution;
  const waiting = Object.values(activeEncounter(decision)?.pendingRolls ?? {}).some(
    (pending) => pending.purpose === "check" && pending.resolutionId === resolution.id,
  );
  if (after != null && !waiting && after.reaction == null) {
    // A landed weapon hit still waits on the attacker's Divine Smite answer,
    // unless a slot was already declared up front on the attack itself.
    if (check.kind === "attack" && landed && offerSmite(decision, encounter, after, check.targetId)) return null;
    proceedToEffects(decision);
  }
  return null;
}

// The "land" effects list, extended with Divine Smite's bonus damage when a
// slot was spent on this hit — declared up front (combatAttack's smiteSlot)
// or chosen after the hit landed (smite.ts's pause). Kept out of the plan
// itself (attack-rules.ts's planFor) since the plan is fixed at declare time
// and a post-hit choice isn't known yet; both readers of onLand below go
// through this instead of the plan directly so the extra effect reaches damage
// rolling and application the same way any other does.
export function landEffects(resolution: ResolutionState, encounter: EncounterState): readonly Effect[] {
  const onLand = withStunningStrike(resolution, withCharge(resolution, encounter, withFoeSlayer(resolution, encounter, withMark(resolution, encounter, withDivineStrike(resolution, encounter, withImprovedSmite(resolution, encounter, withSavageAttacks(resolution, encounter)))))));
  const slot = resolution.smiteSlot !== undefined ? resolution.smiteSlot : resolution.source.kind === "weapon" ? (resolution.source.smiteSlot ?? null) : null;
  if (slot === null) return onLand;
  // 2d8 for a 1st-level slot, +1d8 per level above that, capped at 5d8; one more d8 against a fiend or undead.
  const struck = encounter.combatants[resolution.targetIds[0] ?? ""];
  const type = struck === undefined ? null : creatureTypeOf(struck.traits);
  const extra = type === "undead" || type === "fiend" ? 1 : 0;
  return [...onLand, { kind: "damage", target: "target", amount: dice(Math.min(5, slot + 1) + extra, 8), damageType: "radiant" }];
}

// Stunning Strike: the hit stuns unless the target makes a Constitution save (until the end of the monk's next turn, played as a round).
function withStunningStrike(resolution: ResolutionState, effects: readonly Effect[]): readonly Effect[] {
  const { source } = resolution;
  if (source.kind !== "weapon" || source.stunDc === undefined) return effects;
  return [...effects, { kind: "conditionUnlessSave", target: "target", ability: "con", dc: source.stunDc, condition: "condition:stunned", duration: { kind: "rounds", count: 1 } }];
}

// Cutting Words: a bard on the other side, with its reaction and an inspiration use left, takes the die's average off an attack roll
// that would hit. Returns how much was taken (0 when nothing was done, or it would not have turned the hit).
function cuttingWords(decision: Decision, encounter: EncounterState, attackerId: CombatantId, total: number, against: number): number {
  const attacker = encounter.combatants[attackerId];
  if (attacker === undefined) return 0;
  const key = "spell:bardic-inspiration";
  for (const bard of Object.values(encounter.combatants)) {
    if (bard.side === attacker.side || !isPresent(bard) || bard.hp <= 0 || !bard.budget.reaction || !bard.traits.some((trait) => trait.kind === "cuttingWords")) continue;
    if ((distanceBetween(encounter, bard.id, attacker.id) ?? Infinity) > 60) continue;
    if ((bard.resources.featureUses[innateUseKey(key)] ?? bard.spellcasting?.innate?.[key] ?? 0) < 1) continue;
    const sides = bard.level >= 15 ? 12 : bard.level >= 10 ? 10 : bard.level >= 5 ? 8 : 6;
    const taken = Math.floor((sides + 1) / 2);
    if (total - taken >= against) continue;
    decision.emit({ kind: "uncannyDodgeUsed", combatantId: bard.id });
    decision.emit({ kind: "monsterStateChanged", combatantId: bard.id, innateSpent: key });
    return taken;
  }
  return 0;
}

// A condition the creature cannot gain, of its own or from an ally's aura in the same zone.
function immuneTo(decision: Decision, encounter: EncounterState | undefined, target: Combatant, condition: ContentId<"condition">): boolean {
  if (isImmuneToCondition(target.traits, condition)) return true;
  if (modifiersOf(target, conditionLookup(decision.ctx.rules.content)).some(({ modifier }) => modifier.kind === "conditionImmunity" && modifier.conditions.includes(condition))) return true;
  return Object.values(encounter?.combatants ?? {}).some(
    (other) => other.side === target.side && other.zoneId === target.zoneId && other.hp > 0 && other.traits.some((trait) => trait.kind === "auraOfImmunity" && trait.conditions.includes(condition)),
  );
}

// Dark One's Blessing: the attacker gains temporary hit points for dropping a hostile creature to 0.
function blessedByKill(decision: Decision, resolution: ResolutionState, target: Combatant): void {
  const encounter = activeEncounter(decision);
  const actor = encounter?.combatants[resolution.actorId];
  const after = encounter?.combatants[target.id];
  if (actor === undefined || after === undefined || actor.side === target.side || target.hp <= 0 || after.hp > 0 || !actor.traits.some((trait) => trait.kind === "darkOnesBlessing")) return;
  applyTempHp(decision, actor, Math.max(1, (actor.spellcasting?.modifier ?? 0) + actor.level));
}

// Improved Divine Smite: every melee weapon hit deals 1d8 more radiant damage.
function withImprovedSmite(resolution: ResolutionState, encounter: EncounterState, effects: readonly Effect[]): readonly Effect[] {
  const actor = encounter.combatants[resolution.actorId];
  if (resolution.source.kind !== "weapon" || resolution.source.option.range.kind !== "melee" || actor === undefined || !actor.traits.some((trait) => trait.kind === "improvedDivineSmite")) return effects;
  return [...effects, { kind: "damage", target: "target", amount: dice(1, 8), damageType: "radiant" }];
}

// Hunter's Mark: the caster's weapon hits on a creature they marked deal 1d6 more damage.
function withMark(resolution: ResolutionState, encounter: EncounterState, effects: readonly Effect[]): readonly Effect[] {
  const target = encounter.combatants[resolution.targetIds[0] ?? ""];
  if (resolution.source.kind !== "weapon" || target === undefined) return effects;
  const marked = target.effects.some((held) => held.sourceId === resolution.actorId && held.modifiers.some((modifier) => modifier.kind === "marked"));
  return marked ? [...effects, { kind: "damage", target: "target", amount: dice(1, 6), damageType: resolution.source.option.damageType }] : effects;
}

// Charge and its kin: a melee hit after a run at the target hits harder and may knock it down.
function withCharge(resolution: ResolutionState, encounter: EncounterState, effects: readonly Effect[]): readonly Effect[] {
  const actor = encounter.combatants[resolution.actorId];
  if (resolution.source.kind !== "weapon" || resolution.source.option.range.kind !== "melee" || actor === undefined) return effects;
  const charge = actor.traits.find((trait) => trait.kind === "charge");
  if (charge?.kind !== "charge" || actor.speed - actor.budget.movement < charge.feet) return effects;
  const extra: Effect[] = charge.extra === undefined ? [] : [{ kind: "damage", target: "target", amount: charge.extra, damageType: charge.damageType ?? resolution.source.option.damageType }];
  return [...effects, ...extra, { kind: "conditionUnlessSave", target: "target", ability: "str", dc: charge.dc, condition: "condition:prone" }];
}

// Foe Slayer: the Wisdom modifier on a weapon hit.
function withFoeSlayer(resolution: ResolutionState, encounter: EncounterState, effects: readonly Effect[]): readonly Effect[] {
  const actor = encounter.combatants[resolution.actorId];
  if (resolution.source.kind !== "weapon" || actor === undefined || !actor.traits.some((trait) => trait.kind === "foeSlayer")) return effects;
  const wisdom = actor.spellcasting?.modifier ?? 0;
  return wisdom <= 0 ? effects : [...effects, { kind: "damage", target: "target", amount: flat(wisdom), damageType: resolution.source.option.damageType }];
}

// Divine Strike: a weapon hit deals 1d8 more radiant damage, 2d8 from level 14.
function withDivineStrike(resolution: ResolutionState, encounter: EncounterState, effects: readonly Effect[]): readonly Effect[] {
  const actor = encounter.combatants[resolution.actorId];
  if (resolution.source.kind !== "weapon" || actor === undefined || !actor.traits.some((trait) => trait.kind === "divineStrike")) return effects;
  return [...effects, { kind: "damage", target: "target", amount: dice(actor.level >= 14 ? 2 : 1, 8), damageType: "radiant" }];
}

// Savage Attacks: a melee weapon critical hit rolls one more of the weapon's damage dice, on top of the doubled ones.
// Brutal Critical adds more of them.
function withSavageAttacks(resolution: ResolutionState, encounter: EncounterState): readonly Effect[] {
  const { source } = resolution;
  const actor = encounter.combatants[resolution.actorId];
  const struck = Object.values(resolution.outcomes).some((outcome) => outcome.landed && outcome.critical);
  const sides = source.kind === "weapon" ? source.option.damage.terms[0]?.sides : undefined;
  if (source.kind !== "weapon" || source.option.range.kind !== "melee" || !struck || sides === undefined) return resolution.plan.onLand;
  if (actor === undefined) return resolution.plan.onLand;
  const extra = actor.traits.reduce((sum, trait) => sum + (trait.kind === "savageAttacks" ? 1 : trait.kind === "brutalCritical" ? trait.dice : 0), 0);
  if (extra === 0) return resolution.plan.onLand;
  return [...resolution.plan.onLand, { kind: "damage", target: "target", amount: dice(extra, sides), damageType: source.option.damageType, uncritical: true }];
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

  for (const [listName, effects] of [["land", landEffects(resolution, encounter)], ["avoid", resolution.plan.onAvoid]] as const) {
    const targets = resolution.targetIds.filter((targetId) => (resolution.outcomes[targetId]?.landed ?? false) === (listName === "land"));
    // The avoided side's "half as much" is half of the landing side's roll, so that is rolled even when everyone saved.
    const halved = listName === "land" ? new Set(resolution.plan.onAvoid.flatMap((effect, index) => (effect.kind === "damage" && effect.halfOfLand === true ? [index] : []))) : new Set<number>();
    const avoiders = resolution.targetIds.some((targetId) => resolution.outcomes[targetId]?.landed !== true);
    if (targets.length === 0 && !(halved.size > 0 && avoiders)) continue;
    effects.forEach((effect, index) => {
      const key = `${listName}:${index}`;
      if (targets.length === 0 && !halved.has(index)) return;
      if (effect.kind === "damage" && effect.halfOfLand === true) return;
      if (effect.kind === "damage" || effect.kind === "heal" || effect.kind === "tempHp") {
        let expression = effect.amount;
        if (effect.kind === "damage" && listName === "land" && resolution.sneakAttack && !sneakAdded) {
          const sneak = sneakDice(encounter.combatants[resolution.actorId]);
          if (sneak !== null) {
            expression = combine(expression, sneak);
            sneakAdded = true;
          }
        }
        const critical = effect.kind === "damage" && anyCritical && effect.uncritical !== true;
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
          if (target === undefined || immuneTo(decision, encounter, target, effect.condition)) continue;
          const lookup = conditionLookup(decision.ctx.rules.content);
          if (autoFailsSave(target, effect.ability, lookup)) continue;
          const bias = saveBias(target, effect.ability, lookup);
          const racial = hasSaveAdvantage(target.traits, effect.ability, { conditions: [effect.condition], damageTypes: [], magic: resolution.source.kind === "spell" }) ? 1 : 0;
          const spec: RollSpec = {
            kind: "d20Test",
            spec: { mode: resolveRollMode(bias.advantage + racial, bias.disadvantage), modifier: target.saves[effect.ability] + auraBonusFor(encounter, target), bonusDice: bonusDiceFor(target, "save") },
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
    const current = activeEncounter(decision);
    if (current === null) return;
    const effects = listName === "land" ? landEffects(resolution, current) : resolution.plan.onAvoid;
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
  if (waiting) return;
  // The target may answer damage with a spell of its own (Hellish Rebuke) before the action is over.
  const latest = activeEncounter(decision);
  if (latest !== null && latest.resolution != null && offerRetort(decision, latest, latest.resolution)) return;
  finishResolution(decision);
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
    case "damage": {
      const rolled = effect.halfOfLand === true ? Math.floor((resolution.rolled[key.replace("avoid:", "land:")] ?? 0) / 2) : (resolution.rolled[key] ?? 0);
      // Uncanny Dodge: halves an attack's damage, automatically whenever
      // the reaction is there (see the trait's own comment for why no
      // prompt). Only against an attack roll, not a saving throw, matching
      // the SRD ("hits you with an attack").
      const isAttack = resolution.plan.check?.kind === "weaponAttack" || resolution.plan.check?.kind === "spellAttack";
      const dodges = isAttack && recipient.traits.some((trait) => trait.kind === "uncannyDodge") && recipient.budget.reaction;
      if (dodges) decision.emit({ kind: "uncannyDodgeUsed", combatantId: recipient.id });
      // Evasion: a Dexterity save against damage that halves on a success takes nothing on a success and half on a failure.
      const evades =
        resolution.plan.check?.kind === "savingThrow" && resolution.plan.check.ability === "dex" && recipient.traits.some((trait) => trait.kind === "evasion") && resolution.plan.onAvoid.some((other) => other.kind === "damage" && other.halfOfLand === true);
      const taken = evades ? (effect.halfOfLand === true ? 0 : Math.floor(rolled / 2)) : rolled;
      // Deflect Missiles: the reaction turns a ranged weapon hit down by the die's average, the Dexterity modifier and the level.
      const deflects = !dodges && resolution.source.kind === "weapon" && resolution.source.option.range.kind === "ranged" && isAttack && recipient.traits.some((trait) => trait.kind === "deflectMissiles") && recipient.budget.reaction;
      if (deflects) decision.emit({ kind: "uncannyDodgeUsed", combatantId: recipient.id });
      const deflected = deflects ? 6 + abilityModifier(decision.state.characters[recipient.id]?.abilityScores.dex ?? 10) + recipient.level : 0;
      applyDamage(decision, recipient, dodges ? Math.floor(taken / 2) : Math.max(0, taken - deflected), critical, effect.damageType);
      blessedByKill(decision, resolution, recipient);
      return;
    }
    case "heal": {
      applyHealing(decision, recipient, resolution.rolled[key] ?? 0);
      // Blessed Healer: a spell that heals someone else heals the caster too.
      const healer = activeEncounter(decision)?.combatants[resolution.actorId];
      if (healer !== undefined && healer.id !== recipient.id && resolution.source.kind === "spell" && resolution.source.slotLevel > 0 && healer.traits.some((trait) => trait.kind === "blessedHealer")) {
        applyHealing(decision, healer, 2 + resolution.source.slotLevel);
      }
      return;
    }
    case "tempHp":
      applyTempHp(decision, recipient, resolution.rolled[key] ?? 0);
      return;
    case "applyCondition":
      if (!immuneTo(decision, activeEncounter(decision) ?? undefined, recipient, effect.condition)) {
        decision.emit({ kind: "effectApplied", combatantId: recipient.id, effect: conditionInstance(resolution, recipient, effect.condition, key, effect.duration, round, decision.ctx.rules.content) });
      }
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
    case "polymorph": {
      const beast = decision.ctx.rules.content.find(effect.monsterId);
      if (beast?.kind !== "monster" || recipient.wildShapeOriginal !== null || recipient.hp <= 0) return;
      const concentrating = resolution.source.kind === "spell" && decision.ctx.rules.content.get(resolution.source.spellId).concentration;
      decision.emit({
        kind: "wildShapeChanged",
        combatantId: recipient.id,
        attacks: monsterAttackOptions(beast, decision.ctx.rules.content),
        armorClass: beast.armorClass,
        speed: beast.speed,
        traits: beast.traits,
        maxHp: beast.maxHp,
        hp: beast.maxHp,
        original: { attacks: recipient.attacks, armorClass: recipient.armorClass, speed: recipient.speed, traits: recipient.traits, maxHp: recipient.maxHp, hp: recipient.hp },
        ...(concentrating ? { boundTo: resolution.id } : {}),
      });
      return;
    }
    case "removeCondition": {
      const effectIds = recipient.effects.filter((held) => effect.conditions.some((condition) => held.definition === condition)).map((held) => held.id);
      if (effectIds.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: recipient.id, effectIds, reason: "cured" });
      return;
    }
    case "setLighting":
      decision.emit({ kind: "lightingChanged", zoneId: recipient.zoneId, lighting: effect.lighting });
      return;
    case "gainSlot":
      decision.emit({ kind: "slotGained", combatantId: recipient.id, level: effect.level });
      return;
    case "grantMovement":
      decision.emit({ kind: "movementGranted", combatantId: recipient.id, feet: effect.feet });
      return;
    case "grantAction":
      decision.emit({ kind: "actionGranted", combatantId: recipient.id, ...(effect.attacks === undefined ? {} : { attacks: effect.attacks }) });
      return;
    case "applyModifiers": {
      const spellId = resolution.source.kind === "spell" ? resolution.source.spellId : null;
      const concentrating = spellId !== null && decision.ctx.rules.content.get(spellId).concentration;
      decision.emit({
        kind: "effectApplied",
        combatantId: recipient.id,
        effect: {
          id: `${resolution.id}:${recipient.id}:${key}`,
          definition: spellId ?? (resolution.source.kind === "feature" ? resolution.source.featureId : "effect:modifiers"),
          sourceId: resolution.actorId,
          conditions: [],
          modifiers: effect.modifiers,
          triggers: effect.triggers ?? [],
          clock: effect.duration.kind === "rounds" ? { follows: "source", boundary: "start", untilRound: round + effect.duration.count } : null,
          concentrationId: concentrating ? resolution.id : null,
          stacking: "replace",
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
      if (
        !immuneTo(decision, activeEncounter(decision) ?? undefined, recipient, effect.condition) &&
        (resolution.rolled[`rider:${recipient.id}:${key}`] === 0 || autoFailsSave(recipient, effect.ability, conditionLookup(decision.ctx.rules.content)))
      ) {
        decision.emit({ kind: "effectApplied", combatantId: recipient.id, effect: conditionInstance(resolution, recipient, effect.condition, key, effect.duration ?? null, round, decision.ctx.rules.content) });
      }
      return;
    case "push": {
      const from = decision.state.encounter?.combatants[resolution.actorId]?.zoneId ?? recipient.zoneId;
      const encounter = activeEncounter(decision);
      if (encounter === null) return;
      const distanceFrom = (zone: string): number => shortestPath(encounter.edges, from, zone)?.feet ?? Infinity;
      const here = distanceFrom(recipient.zoneId);
      const options = encounter.edges
        .flatMap((edge) => (edge.from === recipient.zoneId ? [{ zone: edge.to, feet: edge.feet }] : edge.to === recipient.zoneId ? [{ zone: edge.from, feet: edge.feet }] : []))
        .filter((edge) => edge.feet <= 10 && distanceFrom(edge.zone) > here)
        .sort((a, b) => distanceFrom(b.zone) - distanceFrom(a.zone) || a.zone.localeCompare(b.zone));
      // A move of no distance still breaks any melee the creature was in.
      decision.emit({ kind: "combatantMoved", combatantId: recipient.id, zoneId: options[0]?.zone ?? recipient.zoneId, feet: 0 });
      return;
    }
    case "summon": {
      const monster = decision.ctx.rules.content.find(effect.monsterId);
      if (monster?.kind !== "monster") return;
      const slug = effect.monsterId.slice("monster:".length);
      for (let index = effect.count - 1; index >= 0; index -= 1) {
        const letter = effect.count > 1 ? String.fromCharCode(65 + index) : null;
        const id = `${recipient.id}-${slug}${letter === null ? "" : `-${letter.toLowerCase()}`}-${resolution.id}`;
        const summoned = monsterCombatant(monster, decision.ctx.rules.content, { id, letter, zoneId: recipient.zoneId, npcId: null, fleeBelowHpFraction: null });
        const concentrating = resolution.source.kind === "spell" && decision.ctx.rules.content.get(resolution.source.spellId).concentration;
        decision.emit({
          kind: "combatantSummoned",
          summonerId: recipient.id,
          combatant: { ...summoned, side: "party", initiative: recipient.initiative, ...(concentrating ? { boundTo: resolution.id } : {}) },
        });
      }
      return;
    }
    case "destroy": {
      const definition = recipient.source.kind === "monster" ? decision.ctx.rules.content.find(recipient.source.monsterId) : undefined;
      if (definition?.kind === "monster" && definition.xp <= effect.maxXp && recipient.hp > 0) {
        decision.emit({ kind: "combatantHpChanged", combatantId: recipient.id, change: -recipient.hp, hp: 0, condition: "dead", deathSaves: recipient.deathSaves, cause: "damage" });
      }
      return;
    }
    case "exhaustion":
      decision.emit({ kind: "exhaustionChanged", combatantId: recipient.id, level: Math.min(6, Math.max(0, recipient.exhaustion + effect.amount)) });
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
  content: SealedContent,
): EffectInstance {
  return {
    id: `${resolution.id}:${recipient.id}:${key}`,
    definition: condition,
    sourceId: resolution.actorId,
    conditions: [condition],
    modifiers: [],
    triggers: [],
    clock: duration?.kind === "rounds" ? { follows: "source", boundary: "start", untilRound: round + duration.count } : null,
    // A condition a concentration spell laid on ends with the concentration.
    concentrationId: resolution.source.kind === "spell" && content.get(resolution.source.spellId).concentration ? resolution.id : null,
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
  afterResolution(decision, resolution.resumes ?? resolution);
}
