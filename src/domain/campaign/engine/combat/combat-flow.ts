import type { CombatCommand, EncounterSpec } from "../../commands/campaign-command.js";
import { assertNever } from "../../core/assert-never.js";
import type { RollId, UserId } from "../../core/ids.js";
import { isFallen } from "../../state/campaign-state.js";
import type { ActionCost } from "../../combat/combat-events.js";
import {
  areEngaged,
  bonusDiceFor,
  currentCombatant,
  engagedWith,
  hasCondition,
  isActive,
  isPresent,
  type AttackOption,
  type Combatant,
  type EncounterState,
  type PendingCombatRoll,
  type ResolutionState,
  type TurnPlanRemainder,
} from "../../combat/combat-state.js";
import { defaultHeroResources, heroCombatant, monsterCombatant } from "../../combat/combatant-profile.js";
import { distanceBetween, edgeBetween, engageCost, withdrawCost } from "../../combat/positioning.js";
import { chooseAutopilotPlan, chooseMonsterPlan, type TurnPlan } from "../../combat/tactics.js";
import { resolveD20Test, type D20TestSpec } from "../../dice/d20-test.js";
import { classifyRollMoments } from "../../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult } from "../../dice/roll-spec.js";
import type { ContentId } from "../../rules/content-id.js";
import { awaySafety } from "../../rules/house-rules.js";
import { deadlineAfter, type Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { maxNarrationLength } from "../narration-limits.js";
import { openRound } from "../rounds.js";
import { useItemInCombat } from "./combat-gear.js";
import { declareResolution, endConcentration, recordResolutionRoll } from "./resolution.js";

// A chain of engine-played turns (monsters, autopilot, skipped heroes) must
// stop at a player's turn or a roll; this guards against an engine bug
// looping forever inside one decision.
const maxTurnsPerDecision = 64;
const prone = "condition:prone";
const noCost: ActionCost = { action: false, bonusAction: false, reaction: false, spellSlot: null, featureUse: null };

export function handleCombatCommand(decision: Decision, command: CombatCommand): Rejection | null {
  switch (command.kind) {
    case "startEncounter":
      return startEncounter(decision, command.spec);
    case "combatMove":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const edge = edgeBetween(encounter.edges, hero.zoneId, command.zoneId);
        if (edge === undefined) return { code: "notAdjacent" };
        if (edge.feet > hero.budget.movement) return { code: "notEnoughMovement", needed: edge.feet, left: hero.budget.movement };
        startMove(decision, hero, "move", command.zoneId, edge.feet, null);
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
        startMove(decision, hero, "withdraw", null, withdrawCost, null);
        return null;
      });
    case "combatAttack":
      return withHeroTurn(decision, command.combatantId, (hero) => {
        const option = hero.attacks.find((attack) => attack.weapon === command.weapon);
        if (option === undefined) return { code: "unknownWeapon" };
        return declareWeaponAttack(decision, hero, command.targetId, option, "action");
      });
    case "combatCast":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) =>
        castSpell(decision, encounter, hero, command.spellId, command.slotLevel, command.targetIds),
      );
    case "combatUseItem":
      return useItemInCombat(decision, command.combatantId, command.itemId);
    case "combatUseFeature":
      return withHeroTurn(decision, command.combatantId, (hero) => useFeature(decision, hero, command.featureId));
    case "combatDash":
    case "combatDodge":
    case "combatDisengage":
      return withHeroTurn(decision, command.combatantId, (hero) => {
        if (!hero.budget.action) return { code: "noActionLeft" };
        const action = command.kind === "combatDash" ? "dash" : command.kind === "combatDodge" ? "dodge" : "disengage";
        decision.emit({ kind: "actionTaken", combatantId: hero.id, action, bonus: false });
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
  beginEncounter(decision, spec);
  return null;
}

// Starts a validated fight: by the organizer, or after the round in which
// the Planner queued it has been narrated.
export function beginEncounter(decision: Decision, spec: EncounterSpec): void {
  const { state, ctx } = decision;
  const content = ctx.rules.content;
  const combatants: Record<string, Combatant> = {};
  for (const member of Object.values(state.members)) {
    const sheet = member.characterId === null ? undefined : state.characters[member.characterId];
    if (sheet === undefined || isFallen(state, sheet.id)) continue;
    const status = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: defaultHeroResources(sheet, content) };
    combatants[sheet.id] = heroCombatant(sheet, content, spec.partyZoneId, status);
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
    const rollSpec: D20TestSpec = { mode: "normal", modifier: combatant.initiativeModifier, bonusDice: [] };
    pendingRolls[`${spec.id}:roll:${++sequence}`] = { purpose: "initiative", combatantId: combatant.id, spec: rollSpec };
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
    resolution: null,
    pendingMove: null,
    pendingRolls,
    sequence,
    outcome: null,
    deferredTurn: null,
    narratedRound: 0,
    spec,
    loot: spec.loot ?? [],
    gold: spec.gold ?? 0,
  };
  decision.emit({ kind: "encounterStarted", encounter });
  for (const [rollId, pending] of Object.entries(pendingRolls)) {
    if (pending.purpose === "initiative") decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec: pending.spec } });
  }
  decision.request({ kind: "deliver", delivery: { kind: "encounterStarted", encounterId: spec.id } });
}

export function encounterProblems(decision: Decision, spec: EncounterSpec): readonly string[] {
  const problems: string[] = [];
  if (decision.state.encounterHistory.includes(spec.id)) problems.push("This encounter has already been fought.");
  const zoneIds = new Set(spec.zones.map((zone) => zone.id));
  if (zoneIds.size !== spec.zones.length) problems.push("Zone IDs repeat.");
  if (!zoneIds.has(spec.partyZoneId)) problems.push(`Party zone ${spec.partyZoneId} does not exist.`);
  for (const edge of spec.edges) {
    if (!zoneIds.has(edge.from) || !zoneIds.has(edge.to)) problems.push(`Edge ${edge.from}-${edge.to} names an unknown zone.`);
    if (!Number.isInteger(edge.feet) || edge.feet <= 0) problems.push(`Edge ${edge.from}-${edge.to} needs a positive distance.`);
  }
  if (spec.monsters.length === 0) problems.push("An encounter needs at least one monster.");
  if (spec.gold !== undefined && (!Number.isInteger(spec.gold) || spec.gold < 0)) problems.push("Gold must be a whole number of zero or more.");
  for (const item of spec.loot ?? []) {
    if (decision.ctx.rules.content.find(item)?.kind !== "item") problems.push(`Unknown loot item ${item}.`);
  }
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
  const encounter = activeEncounter(decision);
  const pending = encounter?.pendingRolls[rollId];
  if (encounter === null || pending === undefined) return { code: "unknownRoll" };
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
    case "deathSave":
      return resolveDeathSave(decision, encounter, pending, rollId, result);
    case "check":
    case "effect":
    case "concentration":
      return recordResolutionRoll(decision, pending, rollId, result);
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

// --------------------------------------------------------------- Actions

function declareWeaponAttack(
  decision: Decision,
  attacker: Combatant,
  targetId: string,
  option: AttackOption,
  purpose: "action" | "opportunity",
): Rejection | null {
  const encounter = activeEncounter(decision);
  if (encounter === null) return { code: "notInCombat" };
  if (purpose === "action" && !attacker.budget.action) return { code: "noActionLeft" };
  const target = encounter.combatants[targetId];
  if (target === undefined || target.side === attacker.side || !isPresent(target)) return { code: "invalidTarget" };
  if (option.range.kind === "melee" && !areEngaged(encounter, attacker.id, target.id)) return { code: "notEngaged" };
  const distance = distanceBetween(encounter, attacker.id, target.id);
  if (option.range.kind === "ranged" && (distance === null || distance > option.range.long)) return { code: "outOfRange" };
  return declareResolution(decision, {
    actor: attacker,
    source: { kind: "weapon", option },
    targetIds: [target.id],
    purpose,
    cost: { ...noCost, action: purpose === "action", reaction: purpose === "opportunity" },
  });
}

function castSpell(
  decision: Decision,
  encounter: EncounterState,
  caster: Combatant,
  spellId: ContentId<"spell">,
  slotLevel: number,
  targetIds: readonly string[],
): Rejection | null {
  const casting = caster.spellcasting;
  const spell = decision.ctx.rules.content.find(spellId);
  if (casting === null || spell?.kind !== "spell" || !casting.spells.includes(spell.id)) return { code: "unknownSpell" };
  if (spell.level === 0 ? slotLevel !== 0 : slotLevel < spell.level || (caster.resources.spellSlots[slotLevel] ?? 0) < 1) {
    return { code: "noSpellSlot", slotLevel };
  }
  if (spell.castingTime === "reaction") return { code: "unknownSpell" };
  const bonus = spell.castingTime === "bonus-action";
  if (bonus ? !caster.budget.bonusAction : !caster.budget.action) return { code: "noActionLeft" };

  const extra = spell.level === 0 ? 0 : (spell.targeting.countPerHigherSlot ?? 0) * (slotLevel - spell.level);
  const maxTargets = spell.targeting.count + extra;
  const targets = spell.targeting.relation === "self" ? [caster.id] : targetIds;
  if (targets.length === 0 || targets.length > maxTargets || new Set(targets).size !== targets.length) {
    return { code: "invalidTargets", maxTargets };
  }
  for (const targetId of targets) {
    const target = encounter.combatants[targetId];
    if (target === undefined || !isPresent(target)) return { code: "invalidTarget" };
    if (spell.targeting.relation === "enemy" && target.side === caster.side) return { code: "invalidTarget" };
    if (spell.targeting.relation === "ally-or-self" && target.side !== caster.side) return { code: "invalidTarget" };
    const inReach =
      spell.range.kind === "self"
        ? target.id === caster.id
        : spell.range.kind === "touch"
          ? // Touch: the positioning contract has no ally adjacency, so any
            // creature in the caster's zone is within reach.
            target.id === caster.id || target.zoneId === caster.zoneId
          : target.id === caster.id || (distanceBetween(encounter, caster.id, target.id) ?? Infinity) <= spell.range.feet;
    if (!inReach) return { code: "outOfRange" };
  }
  return declareResolution(decision, {
    actor: caster,
    source: { kind: "spell", spellId: spell.id, slotLevel },
    targetIds: targets,
    purpose: "action",
    cost: { ...noCost, action: !bonus, bonusAction: bonus, spellSlot: spell.level === 0 ? null : slotLevel },
  });
}

function useFeature(decision: Decision, hero: Combatant, featureId: ContentId<"feature">): Rejection | null {
  const feature = decision.ctx.rules.content.find(featureId);
  if (feature?.kind !== "feature" || feature.action === null || !hero.features.includes(feature.id)) return { code: "unknownFeature" };
  if ((hero.resources.featureUses[feature.id] ?? 0) < 1) return { code: "noUsesLeft" };
  const bonus = feature.action.cost === "bonusAction";
  if (bonus ? !hero.budget.bonusAction : !hero.budget.action) return { code: "noActionLeft" };
  return declareResolution(decision, {
    actor: hero,
    source: { kind: "feature", featureId: feature.id },
    targetIds: [hero.id],
    purpose: "action",
    cost: { ...noCost, action: !bonus, bonusAction: bonus, featureUse: feature.id },
  });
}

// --------------------------------------------------------------- Movement

// Leaving a hostile creature's reach without Disengage provokes an
// opportunity attack from each able foe, resolved before the move happens.
// Players' heroes take their opportunity attacks automatically for now; the
// Discord reaction prompt (panel spec: Reactions) arrives with milestone 2.
function startMove(
  decision: Decision,
  mover: Combatant,
  kind: "move" | "withdraw",
  zoneId: string | null,
  feet: number,
  thenPlan: TurnPlanRemainder | null,
): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const provokers = mover.disengaged
    ? []
    : engagedWith(encounter, mover.id)
        .filter((other) => other.side !== mover.side && isActive(other) && other.budget.reaction)
        .filter((other) => other.attacks.some((attack) => attack.range.kind === "melee"))
        .map((other) => other.id);
  if (provokers.length === 0) {
    performMove(decision, mover.id, kind, zoneId, feet);
    if (thenPlan !== null) continuePlan(decision, mover.id, thenPlan);
    return;
  }
  decision.emit({ kind: "moveInterrupted", move: { combatantId: mover.id, kind, zoneId, feet, provokers, thenPlan } });
  nextOpportunityAttack(decision);
}

function nextOpportunityAttack(decision: Decision): void {
  const encounter = activeEncounter(decision);
  const move = encounter?.pendingMove;
  if (encounter == null || move == null) return;
  const mover = encounter.combatants[move.combatantId];
  const [provokerId, ...rest] = move.provokers;
  if (mover === undefined || !isActive(mover) || provokerId === undefined) {
    completeMove(decision);
    return;
  }
  decision.emit({ kind: "moveInterrupted", move: { ...move, provokers: rest } });
  const provoker = encounter.combatants[provokerId];
  const melee = provoker?.attacks.find((attack) => attack.range.kind === "melee");
  if (provoker === undefined || melee === undefined || !isActive(provoker) || !provoker.budget.reaction) {
    nextOpportunityAttack(decision);
    return;
  }
  if (declareWeaponAttack(decision, provoker, mover.id, melee, "opportunity") !== null) nextOpportunityAttack(decision);
}

function completeMove(decision: Decision): void {
  const move = activeEncounter(decision)?.pendingMove;
  if (move == null) return;
  decision.emit({ kind: "moveCleared" });
  const mover = activeEncounter(decision)?.combatants[move.combatantId];
  if (mover !== undefined && isActive(mover)) {
    performMove(decision, mover.id, move.kind, move.zoneId, move.feet);
    if (move.thenPlan !== null) continuePlan(decision, mover.id, move.thenPlan);
    return;
  }
  // The mover went down mid-move: an engine-played turn simply ends.
  const encounter = activeEncounter(decision);
  if (mover !== undefined && encounter !== null && currentCombatant(encounter)?.id === mover.id && !isPlayerControlled(decision, mover)) {
    endTurn(decision);
  }
}

function performMove(decision: Decision, combatantId: string, kind: "move" | "withdraw", zoneId: string | null, feet: number): void {
  if (kind === "move" && zoneId !== null) decision.emit({ kind: "combatantMoved", combatantId, zoneId, feet });
  else decision.emit({ kind: "combatantWithdrew", combatantId, feet });
}

// Called when an action finishes: resume an interrupted move, or end a turn
// the engine is playing. Players end their own turns.
export function afterResolution(decision: Decision, resolution: ResolutionState): void {
  if (resolution.purpose === "opportunity") {
    nextOpportunityAttack(decision);
    return;
  }
  const actor = activeEncounter(decision)?.combatants[resolution.actorId];
  if (actor !== undefined && !isPlayerControlled(decision, actor)) endTurn(decision);
}

// --------------------------------------------------------------- Death saves

function resolveDeathSave(
  decision: Decision,
  encounter: EncounterState,
  pending: Extract<PendingCombatRoll, { purpose: "deathSave" }>,
  rollId: RollId,
  result: RollResult,
): Rejection | null {
  const hero = encounter.combatants[pending.combatantId];
  if (hero === undefined) return { code: "invalidTarget" };
  if (result.kind !== "d20Test" || !resultMatchesSpec(result, { kind: "d20Test", spec: pending.spec })) return { code: "rollMismatch" };
  const roll = result.roll;
  const natural = roll.d20.natural;
  const moments = classifyRollMoments({ kind: "deathSave", roll, target: 10, naturalRule: "no-effect" });
  const saves = hero.deathSaves;
  let next: { hp: number; condition: Combatant["condition"]; deathSaves: Combatant["deathSaves"] };
  if (natural === 20) {
    next = { hp: 1, condition: "active", deathSaves: { successes: 0, failures: 0 } };
  } else {
    const success = resolveD20Test("deathSave", natural, roll.total, 10, "no-effect").success;
    const failures = saves.failures + (natural === 1 ? 2 : success ? 0 : 1);
    const successes = saves.successes + (success ? 1 : 0);
    if (failures >= 3) next = { hp: 0, condition: "dead", deathSaves: { successes, failures: 3 } };
    else if (successes >= 3) next = { hp: 0, condition: "stable", deathSaves: { successes: 3, failures } };
    else next = { hp: 0, condition: "unconscious", deathSaves: { successes, failures } };
  }
  decision.emit({ kind: "deathSaveRolled", combatantId: hero.id, rollId, roll, moments, ...next });
  decision.request({ kind: "deliver", delivery: { kind: "deathSave", encounterId: encounter.id, combatantId: hero.id } });
  if (endIfDecided(decision)) return null;
  // Back on their feet with a natural 20: the rest of the turn is theirs.
  const revived = activeEncounter(decision)?.combatants[hero.id];
  if (revived !== undefined && isActive(revived)) {
    if (!isPlayerControlled(decision, revived)) playPlan(decision, revived, chooseAutopilotPlan(activeEncounter(decision) ?? encounter, revived));
    return null;
  }
  endTurn(decision);
  return null;
}

// --------------------------------------------------------------- Turns

// A player's turn that had a timer before the pause gets a fresh full one.
export function rearmedTurnDeadline(decision: Decision): number | null {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.status !== "active" || encounter.turnEndsAt === null) return null;
  return deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds);
}

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
  const combatant = encounter.combatants[encounter.order[index] ?? ""];
  if (combatant === undefined || !isPresent(combatant)) return;

  // A new round: the Narrator describes the one that just finished.
  if (currentRound > encounter.round) decision.request({ kind: "narrateCombat", encounterId: encounter.id, round: encounter.round, final: false });

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
  expireEffects(decision, combatant.id, currentRound);

  // Standing up from prone costs half the creature's speed.
  const fresh = activeEncounter(decision)?.combatants[combatant.id] ?? combatant;
  if (isActive(fresh) && hasCondition(fresh, prone)) decision.emit({ kind: "stoodUp", combatantId: fresh.id, feet: Math.floor(fresh.speed / 2) });

  if (combatant.side === "foes") {
    const fraction = combatant.fleeBelowHpFraction;
    if (fraction !== null && combatant.hp < combatant.maxHp * fraction) {
      decision.emit({ kind: "combatantFled", combatantId: combatant.id });
      if (!endIfDecided(decision)) endTurn(decision);
      return;
    }
    playPlan(decision, currentOf(decision, combatant), chooseMonsterPlan(activeEncounter(decision) ?? encounter, currentOf(decision, combatant)));
    return;
  }
  if (combatant.condition === "unconscious") {
    // Protected while away: no death saves; the hero is simply stable.
    if (isProtected(decision, combatant)) {
      stabilize(decision, combatant);
      endTurn(decision);
      return;
    }
    const current = activeEncounter(decision) ?? encounter;
    const sequence = current.sequence + 1;
    const rollId = `${encounter.id}:roll:${sequence}`;
    const spec: D20TestSpec = { mode: "normal", modifier: 0, bonusDice: bonusDiceFor(combatant, "save") };
    decision.emit({ kind: "deathSaveRequested", combatantId: combatant.id, rollId, pending: { purpose: "deathSave", combatantId: combatant.id, spec }, sequence });
    decision.request({ kind: "roll", rollId, spec: { kind: "d20Test", spec } });
    return;
  }
  if (combatant.condition === "stable") {
    endTurn(decision);
    return;
  }
  if (!playerTurn) playPlan(decision, currentOf(decision, combatant), chooseAutopilotPlan(activeEncounter(decision) ?? encounter, currentOf(decision, combatant)));
}

// Bless and similar end at the start of their source's turn once their
// rounds are up, taking the source's concentration with them.
function expireEffects(decision: Decision, sourceId: string, round: number): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const source = encounter.combatants[sourceId];
  const expired = Object.values(encounter.combatants).some((combatant) =>
    combatant.effects.some(
      (effect) => effect.kind === "bonusDie" && effect.sourceId === sourceId && effect.expiresAtRound !== null && round >= effect.expiresAtRound,
    ),
  );
  if (!expired) return;
  if (source?.concentration != null) endConcentration(decision, sourceId, "expired");
  for (const combatant of Object.values(activeEncounter(decision)?.combatants ?? {})) {
    const effectIds = combatant.effects.flatMap((effect) =>
      effect.kind === "bonusDie" && effect.sourceId === sourceId && effect.expiresAtRound !== null && round >= effect.expiresAtRound ? [effect.id] : [],
    );
    if (effectIds.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: combatant.id, effectIds });
  }
}

// Executes an engine-chosen plan through the same steps players use.
function playPlan(decision: Decision, combatant: Combatant, plan: TurnPlan): void {
  if (plan.disengage) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "disengage", bonus: true });
  if (plan.dash) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "dash", bonus: false });
  if (plan.dodge) decision.emit({ kind: "actionTaken", combatantId: combatant.id, action: "dodge", bonus: false });
  continuePlan(decision, combatant.id, { moves: plan.moves, engage: plan.engage, attack: plan.attack });
}

function continuePlan(decision: Decision, combatantId: string, plan: TurnPlanRemainder): void {
  const encounter = activeEncounter(decision);
  const combatant = encounter?.combatants[combatantId];
  if (encounter == null || combatant === undefined) return;
  const [next, ...rest] = plan.moves;
  if (next !== undefined) {
    const feet = edgeBetween(encounter.edges, combatant.zoneId, next)?.feet;
    if (feet !== undefined && feet <= combatant.budget.movement) {
      startMove(decision, combatant, "move", next, feet, { ...plan, moves: rest });
      return;
    }
  }
  const current = activeEncounter(decision)?.combatants[combatantId] ?? combatant;
  if (!isActive(current)) {
    endTurn(decision);
    return;
  }
  if (plan.engage !== null) {
    const target = activeEncounter(decision)?.combatants[plan.engage];
    const engaged = activeEncounter(decision) !== null && areEngaged(activeEncounter(decision) as EncounterState, current.id, plan.engage);
    if (target !== undefined && isPresent(target) && target.zoneId === current.zoneId && !engaged && current.budget.movement >= engageCost) {
      decision.emit({ kind: "combatantEngaged", combatantId: current.id, targetId: target.id, feet: engageCost });
    }
  }
  if (plan.attack !== null) {
    const attacker = activeEncounter(decision)?.combatants[combatantId] ?? current;
    if (declareWeaponAttack(decision, attacker, plan.attack.targetId, plan.attack.option, "action") === null) return;
  }
  endTurn(decision);
}

function endTurn(decision: Decision): void {
  const encounter = activeEncounter(decision);
  if (encounter === null) return;
  const combatant = currentCombatant(encounter);
  if (combatant !== undefined) {
    if (encounter.turnEndsAt !== null) decision.request({ kind: "cancelTimer", timerId: turnTimerId(encounter.id, encounter.turnNumber) });
    // Guiding Bolt's advantage lasts until the end of the caster's next turn.
    for (const target of Object.values(encounter.combatants)) {
      const effectIds = target.effects.flatMap((effect) =>
        effect.kind === "attackedWithAdvantage" && effect.sourceId === combatant.id && effect.castRound < encounter.round ? [effect.id] : [],
      );
      if (effectIds.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: target.id, effectIds });
    }
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
  if (encounter?.id !== encounterId || encounter.turnNumber !== turnNumber) return null;
  if (encounter.resolution !== null || encounter.pendingMove !== null || decision.state.status !== "active") return null;
  const combatant = currentCombatant(encounter);
  if (combatant === undefined) return null;
  // Apply the away policy to what is left of the turn, then end it once.
  if (combatant.budget.action && isActive(combatant)) playPlan(decision, combatant, chooseAutopilotPlan(encounter, combatant));
  else endTurn(decision);
  return null;
}

// --------------------------------------------------------------- Away mode

// A player may not step away to dodge the consequences at 0 HP, on their
// own turn, or with a death save pending (plan §5, Protected while away).
export function awayRestriction(decision: Decision, userId: UserId): Rejection | null {
  const encounter = activeEncounter(decision);
  const characterId = decision.state.members[userId]?.characterId;
  const hero = characterId == null ? undefined : encounter?.combatants[characterId];
  if (encounter === null || hero === undefined || encounter.status !== "active") return null;
  const ownTurn = currentCombatant(encounter)?.id === hero.id;
  if (hero.hp === 0 && hero.condition !== "dead") return { code: "cannotLeaveNow" };
  if (ownTurn) return { code: "cannotLeaveNow" };
  return null;
}

// When away takes effect, a dying hero becomes stable at once.
export function onMemberAway(decision: Decision, userId: UserId): void {
  const encounter = activeEncounter(decision);
  const characterId = decision.state.members[userId]?.characterId;
  const hero = characterId == null ? undefined : encounter?.combatants[characterId];
  if (hero?.condition === "unconscious" && isProtected(decision, hero)) stabilize(decision, hero);
}

function stabilize(decision: Decision, hero: Combatant): void {
  decision.emit({
    kind: "combatantHpChanged",
    combatantId: hero.id,
    change: 0,
    hp: 0,
    condition: "stable",
    deathSaves: { successes: 0, failures: 0 },
    cause: "protectedWhileAway",
  });
}

export function isProtected(decision: Decision, combatant: Combatant): boolean {
  if (combatant.source.kind !== "hero") return false;
  if (decision.ctx.rules.houseRules.option(awaySafety) !== "protected") return false;
  const ownerId = decision.state.characters[combatant.source.characterId]?.ownerUserId;
  return ownerId !== undefined && decision.state.members[ownerId]?.availability === "away";
}

// --------------------------------------------------------------- Helpers

export function withHeroTurn(
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
  if (encounter.resolution !== null || encounter.pendingMove !== null) return { code: "attackInProgress" };
  return act(hero, encounter);
}

// A present player drives their hero; everything else is engine-played.
function isPlayerControlled(decision: Decision, combatant: Combatant): boolean {
  if (combatant.source.kind !== "hero") return false;
  const ownerId = decision.state.characters[combatant.source.characterId]?.ownerUserId;
  return ownerId !== undefined && decision.state.members[ownerId]?.availability === "present";
}

export function endIfDecided(decision: Decision): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.status !== "active") return false;
  const combatants = Object.values(encounter.combatants);
  const foesLeft = combatants.some((combatant) => combatant.side === "foes" && isPresent(combatant));
  const heroesStanding = combatants.some((combatant) => combatant.side === "party" && isActive(combatant));
  if (foesLeft && heroesStanding) return false;
  if (encounter.turnEndsAt !== null) decision.request({ kind: "cancelTimer", timerId: turnTimerId(encounter.id, encounter.turnNumber) });
  decision.emit({ kind: "encounterEnded", outcome: foesLeft ? "defeat" : "victory" });
  if (!foesLeft && (encounter.loot.length > 0 || encounter.gold > 0)) {
    decision.emit({ kind: "lootFound", encounterId: encounter.id, items: encounter.loot, gold: encounter.gold });
  }
  decision.request({ kind: "deliver", delivery: { kind: "encounterEnded", encounterId: encounter.id } });
  // The closing narration covers the last round; exploration resumes after it.
  decision.request({ kind: "narrateCombat", encounterId: encounter.id, round: encounter.round, final: true });
  return true;
}

// Saves a flourish (plan §6, Combat presentation). Flourishes never hold up
// turns; one that arrives after a later round was described is dropped. The
// closing narration opens the next exploration round.
export function recordCombatNarration(decision: Decision, encounterId: string, round: number, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > maxNarrationLength) return { code: "emptyNarration" };
  const encounter = state.encounter;
  if (encounter?.id !== encounterId || round <= encounter.narratedRound || round > encounter.round) return { code: "staleNarration" };
  const final = encounter.status === "ended" && round === encounter.round;
  // The current round of a fight still in progress is not over yet.
  if (!final && round === encounter.round) return { code: "staleNarration" };
  decision.emit({ kind: "combatNarrationRecorded", round, text: trimmed, final });
  decision.request({ kind: "deliver", delivery: { kind: "combatNarration", encounterId, round } });
  if (final && state.status === "active" && state.round === null) return openRound(decision);
  return null;
}

export function activeEncounter(decision: Decision): EncounterState | null {
  const encounter = decision.state.encounter;
  return encounter === null || encounter.status === "ended" ? null : encounter;
}

function currentOf(decision: Decision, combatant: Combatant): Combatant {
  return activeEncounter(decision)?.combatants[combatant.id] ?? combatant;
}

export function turnTimerId(encounterId: string, turnNumber: number): string {
  return `turn:${encounterId}:${turnNumber}`;
}
