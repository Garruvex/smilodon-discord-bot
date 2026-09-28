// The combat engine's entry points: the command dispatch, the checks every hero action shares (whose turn it is, who may act for whom),
// and the fight's end. The rest is split by what it does: encounter-start, turn-flow, movement, combat-actions, death-saves, resolution, reactions.
import type { CombatCommand } from "../../commands/campaign-command.js";
import { assertNever } from "../../core/assert-never.js";
import type { RollId } from "../../core/ids.js";
import { actsForOwner } from "../../character/ownership.js";
import { isBuildClass } from "../../character/character-build.js";
import { levelForXp, levelUp } from "../../character/leveling.js";
import { currentCombatant, isActive, isPresent, type Combatant, type EncounterState } from "../../combat/combat-state.js";
import { costProblem, engageProblem, moveProblem, withdrawProblem } from "../../combat/turn-rules.js";
import { engageCost, withdrawCost } from "../../combat/positioning.js";
import { resultMatchesSpec, type RollResult } from "../../dice/roll-spec.js";
import { combatMode, lootGold } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { maxNarrationLength } from "../narration-limits.js";
import { changeShieldInCombat, useItemInCombat } from "./combat-gear.js";
import { recordTriggerRoll } from "./effect-triggers.js";
import { answerReaction, reactionTimerExpired } from "./reactions.js";
import { recordResolutionRoll } from "./resolution.js";
import { initiativeOrder, startEncounter } from "./encounter-start.js";
import { castSpell, declareWeaponAttack, useFeature } from "./combat-actions.js";
import { answerOpportunityAttack, opportunityAttackTimerExpired, startMove } from "./movement.js";
import { resolveDeathSave } from "./death-saves.js";
import { beginTurn, endTurn, resumeAfterTriggers, turnTimerExpired, turnTimerId } from "./turn-flow.js";
import { wildShape } from "./wild-shape.js";
export { beginEncounter, encounterProblems } from "./encounter-start.js";
export { afterResolution } from "./movement.js";
export { awayRestriction, isProtected, onMemberAway } from "./death-saves.js";
export { rearmedTurnDeadline, resumeCombat, turnTimerId } from "./turn-flow.js";

export function handleCombatCommand(decision: Decision, command: CombatCommand): Rejection | null {
  switch (command.kind) {
    case "startEncounter":
      return startEncounter(decision, command.spec);
    case "combatMove":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const checked = moveProblem(encounter, hero, command.zoneId, decision.ctx.rules.content);
        if ("problem" in checked) return checked.problem;
        startMove(decision, hero, "move", command.zoneId, checked.value.feet, null);
        return null;
      });
    case "combatEngage":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const problem = engageProblem(encounter, hero, command.targetId, decision.ctx.rules.content);
        if (problem !== null) return problem;
        decision.emit({ kind: "combatantEngaged", combatantId: hero.id, targetId: command.targetId, feet: engageCost });
        return null;
      });
    case "combatWithdraw":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const problem = withdrawProblem(encounter, hero, decision.ctx.rules.content);
        if (problem !== null) return problem;
        startMove(decision, hero, "withdraw", null, withdrawCost, null);
        return null;
      });
    case "combatAttack":
      return withHeroTurn(decision, command.combatantId, (hero) => {
        const option = hero.attacks.find((attack) => attack.weapon === command.weapon);
        if (option === undefined) return { code: "unknownWeapon" };
        return declareWeaponAttack(decision, hero, command.targetId, option, "action", command.smiteSlot);
      });
    case "combatCast":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) =>
        castSpell(decision, encounter, hero, command.spellId, command.slotLevel, command.targetIds),
      );
    case "combatUseItem":
      return useItemInCombat(decision, command.combatantId, command.itemId);
    case "combatShield":
      return changeShieldInCombat(decision, command.combatantId, command.itemId, command.on);
    case "combatUseFeature":
      return withHeroTurn(decision, command.combatantId, (hero) => useFeature(decision, hero, command.featureId));
    case "combatDash":
    case "combatDodge":
    case "combatDisengage":
      return withHeroTurn(decision, command.combatantId, (hero, encounter) => {
        const action = command.kind === "combatDash" ? "dash" : command.kind === "combatDodge" ? "dodge" : "disengage";
        // Cunning Action (Dodge is not one of its options): free as a bonus
        // action when that is still available, otherwise the ordinary action.
        const cunning = action !== "dodge" && hero.traits.some((trait) => trait.kind === "cunningAction") && hero.budget.bonusAction;
        const cost = costProblem(hero, cunning ? "bonusAction" : "action", decision.ctx.rules.content);
        if (cost !== null) return cost;
        decision.emit({ kind: "actionTaken", combatantId: hero.id, action, bonus: cunning });
        decision.request({ kind: "deliver", delivery: { kind: "combatBeat", encounterId: encounter.id, combatantId: hero.id, beat: action } });
        return null;
      });
    case "combatWildShape":
      return withHeroTurn(decision, command.combatantId, (hero) => wildShape(decision, hero, command.monsterId));
    case "endTurn":
      return withHeroTurn(decision, command.combatantId, () => {
        endTurn(decision);
        return null;
      });
    case "combatReact":
      return answerReaction(decision, command.combatantId, command.spellId, "player");
    case "combatOpportunityAttack":
      return answerOpportunityAttack(decision, command.combatantId, command.take, "player");
    case "reactionTimerExpired":
      return reactionTimerExpired(decision, command.encounterId, command.resolutionId);
    case "opportunityAttackTimerExpired":
      return opportunityAttackTimerExpired(decision, command.encounterId, command.combatantId);
    case "turnTimerExpired":
      return turnTimerExpired(decision, command.encounterId, command.turnNumber);
    default:
      return assertNever(command);
  }
}

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
    case "trigger":
      return recordTriggerRoll(decision, pending, rollId, result, (boundary, creatureId) => resumeAfterTriggers(decision, boundary, creatureId));
    default:
      return assertNever(pending);
  }
}

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
  const owner = state.characters[hero.source.characterId]?.ownerUserId;
  if (ctx.actor.kind !== "user" || owner === undefined || !actsForOwner(state, ctx.actor.userId, owner)) {
    return { code: "notYourCharacter" };
  }
  if (currentCombatant(encounter)?.id !== hero.id || !isActive(hero)) return { code: "notYourTurn" };
  if (encounter.resolution !== null || encounter.pendingMove !== null || encounter.pendingTriggers !== null) return { code: "attackInProgress" };
  return act(hero, encounter);
}

// Whether the actor of this command may act for this hero: its owner, or the player
// the owner named while away.
export function mayActFor(decision: Decision, hero: Combatant): boolean {
  const { state, ctx } = decision;
  if (hero.source.kind !== "hero") return false;
  const owner = state.characters[hero.source.characterId]?.ownerUserId;
  return ctx.actor.kind === "user" && owner !== undefined && actsForOwner(state, ctx.actor.userId, owner);
}

// A present player drives their hero; everything else is engine-played.
export function isPlayerControlled(decision: Decision, combatant: Combatant): boolean {
  if (combatant.source.kind !== "hero") return false;
  if (decision.ctx.rules.houseRules.option(combatMode) === "autopilot") return false;
  const ownerId = decision.state.characters[combatant.source.characterId]?.ownerUserId;
  if (ownerId === undefined) return false;
  if (decision.state.members[ownerId]?.availability === "present") return true;
  // An away owner's hero is driven by the proxy they named, when that player is at the table.
  const proxy = decision.state.proxies?.[ownerId];
  return proxy !== undefined && decision.state.members[proxy]?.availability === "present";
}

// An even share of the gold for each hero still standing, in party order; the
// remainder goes to the first. Nobody standing: it stays in the party purse.
export function goldShares(combatants: Readonly<Record<string, Combatant>>, gold: number): Readonly<Record<string, number>> | undefined {
  if (gold <= 0) return undefined;
  const standing = Object.values(combatants)
    .filter((combatant) => combatant.side === "party" && combatant.condition !== "dead" && combatant.condition !== "fled")
    .flatMap((combatant) => (combatant.source.kind === "hero" ? [combatant.source.characterId] : []));
  if (standing.length === 0) return undefined;
  const each = Math.floor(gold / standing.length);
  const shares: Record<string, number> = {};
  standing.forEach((characterId, index) => {
    shares[characterId] = each + (index === 0 ? gold - each * standing.length : 0);
  });
  return shares;
}

// An even share of a defeated foe's XP for each hero still standing, same
// split as goldShares. Fled foes give none; only what was actually beaten.
export function experienceShares(decision: Decision, encounter: EncounterState): Readonly<Record<string, number>> | undefined {
  const combatants = Object.values(encounter.combatants);
  const defeatedXp = combatants
    .filter((combatant) => combatant.side === "foes" && combatant.condition === "dead" && combatant.source.kind === "monster")
    .reduce((sum, combatant) => sum + decision.ctx.rules.content.get((combatant.source as Extract<Combatant["source"], { kind: "monster" }>).monsterId).xp, 0);
  if (defeatedXp <= 0) return undefined;
  const standing = combatants
    .filter((combatant) => combatant.side === "party" && combatant.condition !== "dead" && combatant.condition !== "fled")
    .flatMap((combatant) => (combatant.source.kind === "hero" ? [combatant.source.characterId] : []));
  if (standing.length === 0) return undefined;
  const each = Math.floor(defeatedXp / standing.length);
  const shares: Record<string, number> = {};
  standing.forEach((characterId, index) => {
    shares[characterId] = each + (index === 0 ? defeatedXp - each * standing.length : 0);
  });
  return shares;
}

// Applies a victory's XP, then levels up every hero it carries across a
// threshold — one characterLeveledUp event per level, so a big award (or a
// low starting level) still lands as a readable sequence.
function grantExperience(decision: Decision, encounterId: string, shares: Readonly<Record<string, number>>): void {
  decision.emit({ kind: "experienceAwarded", encounterId, xp: shares });
  for (const characterId of Object.keys(shares)) {
    let sheet = decision.state.characters[characterId];
    if (sheet === undefined) continue;
    const buildClass = sheet.className;
    if (buildClass === undefined || !isBuildClass(buildClass)) continue;
    const targetLevel = levelForXp(sheet.xp ?? 0);
    while (sheet.level < targetLevel) {
      const next = levelUp(sheet, buildClass);
      decision.emit({
        kind: "characterLeveledUp",
        characterId,
        level: next.level,
        maxHp: next.maxHp,
        abilityScores: next.abilityScores,
        spellcasting: next.spellcasting,
        features: next.features,
      });
      const updated = decision.state.characters[characterId];
      if (updated === undefined) break;
      sheet = updated;
    }
  }
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
    const split = decision.ctx.rules.houseRules.option(lootGold) === "split" ? goldShares(encounter.combatants, encounter.gold) : undefined;
    decision.emit({ kind: "lootFound", encounterId: encounter.id, items: encounter.loot, gold: encounter.gold, ...(split === undefined ? {} : { split }) });
  }
  if (!foesLeft) {
    const xpShares = experienceShares(decision, encounter);
    if (xpShares !== undefined) grantExperience(decision, encounter.id, xpShares);
  }
  decision.request({ kind: "deliver", delivery: { kind: "encounterEnded", encounterId: encounter.id } });
  // The closing narration covers the last round; exploration resumes after it.
  decision.request({ kind: "narrateCombat", encounterId: encounter.id, round: encounter.round, final: true });
  return true;
}

// Saves a flourish (plan §6, Combat presentation). Flourishes never hold up
// turns; one that arrives after a later round was described is dropped. The
// closing narration opens the next exploration round (decide.ts does that).
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
  return null;
}

export function activeEncounter(decision: Decision): EncounterState | null {
  const encounter = decision.state.encounter;
  return encounter === null || encounter.status === "ended" ? null : encounter;
}

export function currentOf(decision: Decision, combatant: Combatant): Combatant {
  return activeEncounter(decision)?.combatants[combatant.id] ?? combatant;
}
