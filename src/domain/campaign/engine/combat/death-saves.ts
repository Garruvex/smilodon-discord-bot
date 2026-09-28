// Heroes at 0 HP: death saves, becoming stable, and the protection an away hero gets.
import type { RollId, UserId } from "../../core/ids.js";
import { currentCombatant, isActive, type Combatant, type EncounterState, type PendingCombatRoll } from "../../combat/combat-state.js";
import { chooseAutopilotPlan } from "../../combat/tactics.js";
import { resolveD20Test } from "../../dice/d20-test.js";
import { classifyRollMoments } from "../../dice/roll-moments.js";
import { resultMatchesSpec, type RollResult } from "../../dice/roll-spec.js";
import { awaySafety } from "../../rules/house-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { declineReactionFor } from "./reactions.js";
import { declineOpportunityAttackFor } from "./movement.js";
import { endTurn, playPlan } from "./turn-flow.js";
import { activeEncounter, endIfDecided, isPlayerControlled } from "./combat-flow.js";

export function resolveDeathSave(
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
  // A window waiting for a player who has gone away closes as a decline.
  if (hero !== undefined) {
    declineReactionFor(decision, hero.id);
    declineOpportunityAttackFor(decision, hero.id);
  }
  if (hero?.condition === "unconscious" && isProtected(decision, hero)) stabilize(decision, hero);
}

export function stabilize(decision: Decision, hero: Combatant): void {
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
