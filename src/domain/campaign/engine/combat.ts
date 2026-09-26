import type { CombatCommand, EncounterSpec } from "../commands/campaign-command.js";
import { assertNever } from "../core/assert-never.js";
import type { RollId } from "../core/ids.js";
import {
  areEngaged,
  currentCombatant,
  engagedWith,
  isActive,
  isPresent,
  type AttackOption,
  type AttackState,
  type Combatant,
  type EncounterState,
  type PendingCombatRoll,
} from "../combat/combat-state.js";
import { heroCombatant, monsterCombatant } from "../combat/combatant-profile.js";
import { distanceBetween, edgeBetween, engageCost, engagedDistance, withdrawCost } from "../combat/positioning.js";
import { chooseAutopilotPlan, chooseMonsterPlan, type TurnPlan } from "../combat/tactics.js";
import { resolveD20Test, type D20TestSpec } from "../dice/d20-test.js";
import { resolveRollMode } from "../dice/roll.js";
import { classifyRollMoments } from "../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult } from "../dice/roll-spec.js";
import { deadlineAfter, type Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// A chain of engine-driven turns (monsters, autopilot, skipped heroes) must
// stop at a player's turn or a roll; this guards against an engine bug
// looping forever inside one decision.
const maxTurnsPerDecision = 64;

export function handleCombatCommand(decision: Decision, command: CombatCommand): Rejection | null {
  switch (command.kind) {
    case "startEncounter":
      return startEncounter(decision, command.spec);
    case "combatMove":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const edge = edgeBetween(encounter.edges, hero.zoneId, command.zoneId);
        if (edge === undefined) return { code: "notAdjacent" };
        if (edge.feet > hero.budget.movement) return { code: "notEnoughMovement", needed: edge.feet, left: hero.budget.movement };
        decision.emit({ kind: "combatantMoved", combatantId: hero.id, zoneId: command.zoneId, feet: edge.feet });
        return null;
      });
    case "combatEngage":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const target = encounter.combatants[command.targetId];
        if (target === undefined || target.side === hero.side || !isPresent(target)) return { code: "invalidTarget" };
        if (target.zoneId !== hero.zoneId) return { code: "notAdjacent" };
        if (areEngaged(encounter, hero.id, target.id)) return { code: "alreadyEngaged" };
        if (hero.budget.movement < engageCost) return { code: "notEnoughMovement", needed: engageCost, left: hero.budget.movement };
        decision.emit({ kind: "combatantEngaged", combatantId: hero.id, targetId: target.id, feet: engageCost });
        return null;
      });
    case "combatWithdraw":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        if (engagedWith(encounter, hero.id).length === 0) return { code: "notEngaged" };
        if (hero.budget.movement < withdrawCost) return { code: "notEnoughMovement", needed: withdrawCost, left: hero.budget.movement };
        decision.emit({ kind: "combatantWithdrew", combatantId: hero.id, feet: withdrawCost });
        return null;
      });
    case "combatAttack":
      return withHeroTurn(decision, command.combatantId, (hero) => {
        const option = hero.attacks.find((attack) => attack.weapon === command.weapon);
        if (option === undefined) return { code: "unknownWeapon" };
        return declareAttack(decision, hero, command.targetId, option);
      });
    case "combatDash":
    case "combatDodge":
      return withHeroTurn(decision, command.combatantId, (hero) => {
        if (!hero.budget.action) return { code: "noActionLeft" };
        decision.emit({ kind: "actionTaken", combatantId: hero.id, action: command.kind === "combatDash" ? "dash" : "dodge" });
        return null;
      });
    case "endTurn":
      return withHeroTurn(decision, command.combatantId, () => {
        endTurn(decision);
        return null;
      });
    case "turnTimerExpired":
      return turnTimerExpired(decision, command.encounterId, command.turnNumber);
    default:
      return assertNever(command);
  }
}

// --------------------------------------------------------------- Start

function startEncounter(decision: Decision, spec: EncounterSpec): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if (state.round !== null) return { code: "roundInProgress" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  const problems = encounterProblems(decision, spec);
  if (problems.length > 0) return { code: "invalidEncounter", problems };

  const content = ctx.rules.content;
  const combatants: Record<string, Combatant> = {};
  for (const member of Object.values(state.members)) {
    const sheet = member.characterId === null ? undefined : state.characters[member.characterId];
    if (sheet !== undefined) combatants[sheet.id] = heroCombatant(sheet, content, spec.partyZoneId, state.heroHp[sheet.id] ?? sheet.maxHp);
  }
  const counts = new Map<string, number>();
  for (const entry of spec.monsters) counts.set(entry.monsterId, (counts.get(entry.monsterId) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const entry of spec.monsters) {
    const monster = content.get(entry.monsterId);
    const index = seen.get(entry.monsterId) ?? 0;
    seen.set(entry.monsterId, index + 1);
    const letter = (counts.get(entry.monsterId) ?? 0) > 1 ? String.fromCharCode(65 + index) : null;
    const slug = entry.monsterId.slice("monster:".length);
    const id = letter === null ? slug : `${slug}-${letter.toLowerCase()}`;
    combatants[id] = monsterCombatant(monster, content, {
      id,
      letter,
      zoneId: entry.zoneId,
      npcId: entry.npcId,
      fleeBelowHpFraction: entry.fleeBelowHpFraction,
    });
  }

  // Everyone rolls initiative at once; turns begin when the last roll lands.
  const pendingRolls: Record<RollId, PendingCombatRoll> = {};
  let sequence = 0;
  for (const combatant of Object.values(combatants)) {
    sequence += 1;
    const spec_: D20TestSpec = { mode: "normal", modifier: combatant.initiativeModifier, bonusDice: [] };
    pendingRolls[rollIdFor(spec.id, sequence)] = { purpose: "initiative", combatantId: combatant.id, spec: spec_ };
  }
  const encounter: EncounterState = {
    id: spec.id,
    status: "initiative",
    round: 0,
    turnNumber: 0,
    order: [],
    turnIndex: 0,
    turnEndsAt: null,
    combatants,
    zones: spec.zones,
    edges: spec.edges,
    engagements: [],
    attack: null,
    pendingRolls,
    sequence,
    outcome: null,
    deferredTurn: null,
  };
  decision.emit({ kind: "encounterStarted", encounter });
  for (const [rollId, pending] of Object.entries(pendingRolls)) {
    if (pending.purpose === "initiative") decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec: pending.spec } });
  }
  decision.request({ kind: "deliver", delivery: { kind: "encounterStarted", encounterId: spec.id } });
  return null;
}

function encounterProblems(decision: Decision, spec: EncounterSpec): readonly string[] {
  const problems: string[] = [];
  const zoneIds = new Set(spec.zones.map((zone) => zone.id));
  if (zoneIds.size !== spec.zones.length) problems.push("Zone IDs repeat.");
  if (!zoneIds.has(spec.partyZoneId)) problems.push(`Party zone ${spec.partyZoneId} does not exist.`);
  for (const edge of spec.edges) {
    if (!zoneIds.has(edge.from) || !zoneIds.has(edge.to)) problems.push(`Edge ${edge.from}-${edge.to} names an unknown zone.`);
    if (!Number.isInteger(edge.feet) || edge.feet <= 0) problems.push(`Edge ${edge.from}-${edge.to} needs a positive distance.`);
  }
  if (spec.monsters.length === 0) problems.push("An encounter needs at least one monster.");
  for (const monster of spec.monsters) {
    if (decision.ctx.rules.content.find(monster.monsterId)?.kind !== "monster") problems.push(`Unknown monster ${monster.monsterId}.`);
    if (!zoneIds.has(monster.zoneId)) problems.push(`${monster.monsterId} is placed in unknown zone ${monster.zoneId}.`);
    const flee = monster.fleeBelowHpFraction;
    if (flee !== null && !(flee > 0 && flee < 1)) problems.push(`${monster.monsterId} flee threshold must be between 0 and 1.`);
  }
  return problems;
}

// --------------------------------------------------------------- Rolls

// Routes a saved roll to the combat stage waiting for it.
export function recordCombatRoll(decision: Decision, rollId: RollId, result: RollResult): Rejection | null {
  const encounter = decision.state.encounter;
  const pending = encounter?.pendingRolls[rollId];
  if (encounter == null || pending === undefined) return { code: "unknownRoll" };
  switch (pending.purpose) {
    case "initiative": {
      if (result.kind !== "d20Test" || !resultMatchesSpec(result, { kind: "d20Test", spec: pending.spec })) return { code: "rollMismatch" };
      decision.emit({ kind: "initiativeRolled", combatantId: pending.combatantId, rollId, roll: result.roll });
      const after = activeEncounter(decision);
      if (after !== null && Object.values(after.pendingRolls).every((roll) => roll.purpose !== "initiative")) {
        decision.emit({ kind: "turnOrderSet", order: initiativeOrder(after) });
        beginTurn(decision, 0, 1);
      }
      return null;
    }
    case "attack":
      return resolveAttackRoll(decision, encounter, result);
    case "damage":
      return resolveDamageRoll(decision, encounter, result);
    case "deathSave":
      return resolveDeathSave(decision, encounter, pending.combatantId, rollId, result);
    default:
      return assertNever(pending);
  }
}

// Highest first; ties go to the higher Dexterity modifier, then heroes, then ID.
function initiativeOrder(encounter: EncounterState): readonly string[] {
  return Object.values(encounter.combatants)
    .sort((a, b) => {
      const byRoll = (b.initiative ?? 0) - (a.initiative ?? 0);
      if (byRoll !== 0) return byRoll;
      const byDex = b.initiativeModifier - a.initiativeModifier;
      if (byDex !== 0) return byDex;
      if (a.side !== b.side) return a.side === "party" ? -1 : 1;
      return a.id.localeCompare(b.id);
    })
    .map((combatant) => combatant.id);
}

// --------------------------------------------------------------- Attacks

function declareAttack(decision: Decision, attacker: Combatant, targetId: string, option: AttackOption): Rejection | null {
  const encounter = activeEncounter(decision);
  if (encounter === null) return { code: "notInCombat" };
  if (!attacker.budget.action) return { code: "noActionLeft" };
  const target = encounter.combatants[targetId];
  if (target === undefined || target.side === attacker.side || !isPresent(target)) return { code: "invalidTarget" };
  const distance = distanceBetween(encounter, attacker.id, target.id);
  if (option.range.kind === "melee" && !areEngaged(encounter, attacker.id, target.id)) return { code: "notEngaged" };
  if (option.range.kind === "ranged" && (distance === null || distance > option.range.long)) return { code: "outOfRange" };

  let advantage = 0;
  let disadvantage = 0;
  const downed = target.condition === "unconscious" || target.condition === "stable";
  if (target.dodging && isActive(target)) disadvantage += 1;
  // Unconscious: attacks have advantage. It is also prone, which gives ranged
  // attacks from beyond 5 feet disadvantage.
  if (downed) advantage += 1;
  if (downed && option.range.kind === "ranged" && (distance ?? 0) > engagedDistance) disadvantage += 1;
  if (option.range.kind === "ranged") {
    if ((distance ?? 0) > option.range.normal) disadvantage += 1;
    const threatened = engagedWith(encounter, attacker.id).some((other) => other.side !== attacker.side && isActive(other));
    if (threatened) disadvantage += 1;
  }
  for (const trait of attacker.traits) {
    switch (trait.kind) {
      case "packTactics": {
        const allyEngaged = engagedWith(encounter, target.id).some(
          (other) => other.side === attacker.side && other.id !== attacker.id && isActive(other),
        );
        if (allyEngaged) advantage += 1;
        break;
      }
      default:
        assertNever(trait.kind);
    }
  }

  const id = rollIdFor(encounter.id, encounter.sequence + 1);
  const attack: AttackState = {
    id,
    attackerId: attacker.id,
    targetId: target.id,
    option,
    spec: { mode: resolveRollMode(advantage, disadvantage), modifier: option.toHit, bonusDice: [] },
    stage: "attackRoll",
    attackRollId: id,
    damageRollId: null,
    critical: false,
  };
  decision.emit({ kind: "attackDeclared", attack });
  decision.request({ kind: "roll", rollId: id, spec: { kind: "d20Test", spec: attack.spec } });
  return null;
}

function resolveAttackRoll(decision: Decision, encounter: EncounterState, result: RollResult): Rejection | null {
  const attack = encounter.attack;
  if (attack?.stage !== "attackRoll") return { code: "unknownRoll" };
  if (result.kind !== "d20Test" || !resultMatchesSpec(result, { kind: "d20Test", spec: attack.spec })) return { code: "rollMismatch" };
  const target = encounter.combatants[attack.targetId];
  if (target === undefined) return { code: "invalidTarget" };
  const roll = result.roll;
  const outcome = resolveD20Test("attack", roll.d20.natural, roll.total, target.armorClass, "no-effect");
  // A hit on an unconscious creature from within 5 feet is a critical hit.
  const downed = target.condition === "unconscious" || target.condition === "stable";
  const critical = outcome.critical || (outcome.success && downed && areEngaged(encounter, attack.attackerId, target.id));
  const moments = classifyRollMoments({ kind: "attack", roll, target: target.armorClass, naturalRule: "no-effect" });
  decision.emit({ kind: "attackRolled", attackId: attack.id, roll, hit: outcome.success, critical, moments });
  decision.request({ kind: "deliver", delivery: { kind: "attackRolled", encounterId: encounter.id, attackId: attack.id } });
  if (!outcome.success) {
    finishAttack(decision, attack);
    return null;
  }
  const damageRollId = rollIdFor(encounter.id, encounter.sequence + 1);
  decision.emit({ kind: "damageRollRequested", attackId: attack.id, rollId: damageRollId });
  decision.request({ kind: "roll", rollId: damageRollId, spec: { kind: "dice", expression: attack.option.damage, critical } });
  return null;
}

function resolveDamageRoll(decision: Decision, encounter: EncounterState, result: RollResult): Rejection | null {
  const attack = encounter.attack;
  if (attack?.stage !== "damageRoll") return { code: "unknownRoll" };
  const spec = { kind: "dice", expression: attack.option.damage, critical: attack.critical } as const;
  if (result.kind !== "dice" || !resultMatchesSpec(result, spec)) return { code: "rollMismatch" };
  decision.emit({ kind: "damageRolled", attackId: attack.id, roll: result.roll });
  const target = encounter.combatants[attack.targetId];
  if (target !== undefined) applyDamage(decision, target, Math.max(0, result.roll.total), attack.critical);
  finishAttack(decision, attack);
  return null;
}

// 2014 rules: damage that leaves a hero at 0 HP knocks them unconscious;
// leftover damage of at least their HP maximum kills outright; damage while
// at 0 HP is a death-save failure (two on a critical). Monsters die at 0.
function applyDamage(decision: Decision, target: Combatant, amount: number, critical: boolean): void {
  const base = { kind: "combatantHpChanged", combatantId: target.id, change: -amount } as const;
  if (target.side === "foes") {
    const hp = Math.max(0, target.hp - amount);
    decision.emit({ ...base, hp, condition: hp === 0 ? "dead" : "active", deathSaves: target.deathSaves, cause: "damage" });
    return;
  }
  if (target.hp === 0) {
    const failures = Math.min(3, target.deathSaves.failures + (critical ? 2 : 1));
    const deathSaves = { successes: target.deathSaves.successes, failures };
    decision.emit({ ...base, hp: 0, condition: failures >= 3 ? "dead" : "unconscious", deathSaves, cause: "damageAtZero" });
    return;
  }
  if (amount < target.hp) {
    decision.emit({ ...base, hp: target.hp - amount, condition: "active", deathSaves: target.deathSaves, cause: "damage" });
    return;
  }
  const massive = amount - target.hp >= target.maxHp;
  decision.emit({
    ...base,
    hp: 0,
    condition: massive ? "dead" : "unconscious",
    deathSaves: { successes: 0, failures: 0 },
    cause: massive ? "massiveDamage" : "damage",
  });
}

function finishAttack(decision: Decision, attack: AttackState): void {
  decision.emit({ kind: "attackFinished", attackId: attack.id });
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  decision.request({ kind: "deliver", delivery: { kind: "attackResolved", encounterId: encounter.id, attackId: attack.id } });
  if (endIfDecided(decision)) return;
  // A player ends their own turn; the engine ends turns it plays.
  const attacker = decision.state.encounter?.combatants[attack.attackerId];
  if (attacker !== undefined && !isPlayerControlled(decision, attacker)) endTurn(decision);
}

// --------------------------------------------------------------- Death saves

function resolveDeathSave(
  decision: Decision,
  encounter: EncounterState,
  combatantId: string,
  rollId: RollId,
  result: RollResult,
): Rejection | null {
  const hero = encounter.combatants[combatantId];
  if (hero === undefined) return { code: "invalidTarget" };
  if (result.kind !== "d20Test" || !resultMatchesSpec(result, { kind: "d20Test", spec: deathSaveSpec })) return { code: "rollMismatch" };
  const roll = result.roll;
  const natural = roll.d20.natural;
  const moments = classifyRollMoments({ kind: "deathSave", roll, target: 10, naturalRule: "no-effect" });
  const saves = hero.deathSaves;
  let next: { hp: number; condition: Combatant["condition"]; deathSaves: Combatant["deathSaves"] };
  if (natural === 20) {
    next = { hp: 1, condition: "active", deathSaves: { successes: 0, failures: 0 } };
  } else {
    const failures = saves.failures + (natural === 1 ? 2 : roll.total < 10 ? 1 : 0);
    const successes = saves.successes + (natural !== 1 && roll.total >= 10 ? 1 : 0);
    if (failures >= 3) next = { hp: 0, condition: "dead", deathSaves: { successes, failures: 3 } };
    else if (successes >= 3) next = { hp: 0, condition: "stable", deathSaves: { successes: 3, failures } };
    else next = { hp: 0, condition: "unconscious", deathSaves: { successes, failures } };
  }
  decision.emit({ kind: "deathSaveRolled", combatantId, rollId, roll, moments, ...next });
  decision.request({ kind: "deliver", delivery: { kind: "deathSave", encounterId: encounter.id, combatantId } });
  if (endIfDecided(decision)) return null;
  // Back on their feet with a natural 20: the rest of the turn is theirs.
  const revived = decision.state.encounter?.combatants[combatantId];
  if (revived !== undefined && isActive(revived)) {
    if (!isPlayerControlled(decision, revived)) playPlan(decision, revived, chooseAutopilotPlan(activeEncounter(decision) ?? encounter, revived));
    return null;
  }
  endTurn(decision);
  return null;
}

const deathSaveSpec: D20TestSpec = { mode: "normal", modifier: 0, bonusDice: [] };

// --------------------------------------------------------------- Turns

// Starts the turn that was due when the table emptied.
export function resumeCombat(decision: Decision): void {
  const deferred = activeEncounter(decision)?.deferredTurn;
  if (deferred != null) beginTurn(decision, deferred.turnIndex, deferred.round);
}

function beginTurn(decision: Decision, turnIndex: number, round: number): void {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.order.length === 0) return;
  // Paused while nobody is present; continue starts this turn.
  if (decision.state.status !== "active") {
    decision.emit({ kind: "turnDeferred", turnIndex, round });
    return;
  }
  if (decision.countTurnStart() > maxTurnsPerDecision) throw new Error("Combat turn chain did not stop at a player's turn or a roll.");

  // Skip combatants who are out of the fight.
  let index = turnIndex;
  let currentRound = round;
  for (let skipped = 0; skipped < encounter.order.length; skipped += 1) {
    const candidate = encounter.combatants[encounter.order[index] ?? ""];
    if (candidate !== undefined && isPresent(candidate)) break;
    index += 1;
    if (index >= encounter.order.length) {
      index = 0;
      currentRound += 1;
    }
  }
  const combatantId = encounter.order[index];
  const combatant = combatantId === undefined ? undefined : encounter.combatants[combatantId];
  if (combatant === undefined || !isPresent(combatant)) return;

  const playerTurn = isPlayerControlled(decision, combatant) && isActive(combatant);
  const endsAt = playerTurn ? deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds) : null;
  const turnNumber = encounter.turnNumber + 1;
  decision.emit({ kind: "turnStarted", combatantId: combatant.id, turnIndex: index, round: currentRound, turnNumber, endsAt });
  decision.request({ kind: "deliver", delivery: { kind: "combatTurn", encounterId: encounter.id, combatantId: combatant.id } });
  if (endsAt !== null) {
    decision.request({
      kind: "startTimer",
      timer: { kind: "combatTurn", timerId: turnTimerId(encounter.id, turnNumber), dueAt: endsAt, encounterId: encounter.id, turnNumber },
    });
  }

  if (combatant.side === "foes") {
    const fraction = combatant.fleeBelowHpFraction;
    if (fraction !== null && combatant.hp < combatant.maxHp * fraction) {
      decision.emit({ kind: "combatantFled", combatantId: combatant.id });
      if (!endIfDecided(decision)) endTurn(decision);
      return;
    }
    playPlan(decision, combatant, chooseMonsterPlan(activeEncounter(decision) ?? encounter, combatant));
    return;
  }
  if (combatant.condition === "unconscious") {
    const rollId = rollIdFor(encounter.id, (activeEncounter(decision) ?? encounter).sequence + 1);
    decision.emit({ kind: "deathSaveRequested", combatantId: combatant.id, rollId });
    decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec: deathSaveSpec } });
    return;
  }
  if (combatant.condition === "stable") {
    endTurn(decision);
    return;
  }
  if (!playerTurn) playPlan(decision, combatant, chooseAutopilotPlan(activeEncounter(decision) ?? encounter, combatant));
}

// Executes an engine-chosen plan through the same steps players use.
function playPlan(decision: Decision, combatant: Combatant, plan: TurnPlan): void {
  if (plan.dash) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "dash" });
  let at = combatant.zoneId;
  for (const zone of plan.moves) {
    const feet = edgeBetween(decision.state.encounter?.edges ?? [], at, zone)?.feet;
    if (feet === undefined) break;
    decision.emit({ kind: "combatantMoved", combatantId: combatant.id, zoneId: zone, feet });
    at = zone;
  }
  if (plan.engage !== null) decision.emit({ kind: "combatantEngaged", combatantId: combatant.id, targetId: plan.engage, feet: engageCost });
  if (plan.dodge) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "dodge" });
  if (plan.attack !== null) {
    const current = decision.state.encounter?.combatants[combatant.id] ?? combatant;
    if (declareAttack(decision, current, plan.attack.targetId, plan.attack.option) === null) return;
  }
  endTurn(decision);
}

function endTurn(decision: Decision): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const combatant = currentCombatant(encounter);
  if (combatant !== undefined) {
    if (encounter.turnEndsAt !== null) decision.request({ kind: "cancelTimer", timerId: turnTimerId(encounter.id, encounter.turnNumber) });
    decision.emit({ kind: "turnEnded", combatantId: combatant.id });
  }
  if (endIfDecided(decision)) return;
  const next = encounter.turnIndex + 1;
  if (next >= encounter.order.length) beginTurn(decision, 0, encounter.round + 1);
  else beginTurn(decision, next, encounter.round);
}

function turnTimerExpired(decision: Decision, encounterId: string, turnNumber: number): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const encounter = activeEncounter(decision);
  if (encounter?.id !== encounterId || encounter.turnNumber !== turnNumber || encounter.attack !== null) return null;
  if (decision.state.status !== "active") return null;
  const combatant = currentCombatant(encounter);
  if (combatant === undefined) return null;
  // Apply the away policy to what is left of the turn, then end it once.
  if (combatant.budget.action && isActive(combatant)) playPlan(decision, combatant, chooseAutopilotPlan(encounter, combatant));
  else endTurn(decision);
  return null;
}

// --------------------------------------------------------------- Helpers

function withHeroTurn(
  decision: Decision,
  combatantId: string,
  act: (hero: Combatant, encounter: EncounterState) => Rejection | null,
): Rejection | null {
  const { state, ctx } = decision;
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.status !== "active") return { code: "notInCombat" };
  if (state.status !== "active") return { code: "campaignWaiting" };
  const hero = encounter.combatants[combatantId];
  if (hero?.source.kind !== "hero") return { code: "notYourCharacter" };
  if (ctx.actor.kind !== "user" || state.characters[hero.source.characterId]?.ownerUserId !== ctx.actor.userId) {
    return { code: "notYourCharacter" };
  }
  if (currentCombatant(encounter)?.id !== hero.id || !isActive(hero)) return { code: "notYourTurn" };
  if (encounter.attack !== null) return { code: "attackInProgress" };
  return act(hero, encounter);
}

// A present player drives their hero; everything else is engine-played.
function isPlayerControlled(decision: Decision, combatant: Combatant): boolean {
  if (combatant.source.kind !== "hero") return false;
  const ownerId = decision.state.characters[combatant.source.characterId]?.ownerUserId;
  return ownerId !== undefined && decision.state.members[ownerId]?.availability === "present";
}

function endIfDecided(decision: Decision): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.status !== "active") return false;
  const combatants = Object.values(encounter.combatants);
  const foesLeft = combatants.some((combatant) => combatant.side === "foes" && isPresent(combatant));
  const heroesStanding = combatants.some((combatant) => combatant.side === "party" && isActive(combatant));
  if (foesLeft && heroesStanding) return false;
  const current = currentCombatant(encounter);
  if (encounter.turnEndsAt !== null && current !== undefined) {
    decision.request({ kind: "cancelTimer", timerId: turnTimerId(encounter.id, encounter.turnNumber) });
  }
  decision.emit({ kind: "encounterEnded", outcome: foesLeft ? "defeat" : "victory" });
  decision.request({ kind: "deliver", delivery: { kind: "encounterEnded", encounterId: encounter.id } });
  return true;
}

function activeEncounter(decision: Decision): EncounterState | null {
  const encounter = decision.state.encounter;
  return encounter === null || encounter.status === "ended" ? null : encounter;
}

export function rollIdFor(encounterId: string, sequence: number): RollId {
  return `${encounterId}:roll:${sequence}`;
}

export function turnTimerId(encounterId: string, turnNumber: number): string {
  return `turn:${encounterId}:${turnNumber}`;
}
