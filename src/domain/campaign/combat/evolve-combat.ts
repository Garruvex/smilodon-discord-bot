import { assertNever } from "../core/assert-never.js";
import type { CombatEvent } from "./combat-events.js";
import type { Combatant, CombatantId, EncounterState } from "./combat-state.js";

// Applies one combat event to the encounter. Pure and total, like evolve().
export function evolveEncounter(encounter: EncounterState | null, event: CombatEvent): EncounterState | null {
  if (event.kind === "encounterStarted") return event.encounter;
  if (encounter === null) return null;
  switch (event.kind) {
    case "initiativeRolled":
      return withoutPending(
        updateCombatant(encounter, event.combatantId, (combatant) => ({ ...combatant, initiative: event.roll.total })),
        event.rollId,
      );
    case "turnOrderSet":
      return { ...encounter, status: "active", order: event.order, round: 1, turnIndex: 0 };
    case "turnStarted":
      return updateCombatant(
        {
          ...encounter,
          turnIndex: event.turnIndex,
          round: event.round,
          turnNumber: event.turnNumber,
          turnEndsAt: event.endsAt,
          deferredTurn: null,
        },
        event.combatantId,
        (combatant) => ({
          ...combatant,
          budget: { action: true, bonusAction: true, reaction: true, movement: combatant.speed },
          dodging: false,
        }),
      );
    case "combatantMoved":
      return updateCombatant(withoutEngagements(encounter, event.combatantId), event.combatantId, (combatant) => ({
        ...combatant,
        zoneId: event.zoneId,
        budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet },
      }));
    case "combatantEngaged":
      return updateCombatant(
        { ...encounter, engagements: [...encounter.engagements, [event.combatantId, event.targetId] as const] },
        event.combatantId,
        (combatant) => ({ ...combatant, budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet } }),
      );
    case "combatantWithdrew":
      return updateCombatant(withoutEngagements(encounter, event.combatantId), event.combatantId, (combatant) => ({
        ...combatant,
        budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet },
      }));
    case "actionTaken":
      return updateCombatant(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        budget: {
          ...combatant.budget,
          action: false,
          movement: event.action === "dash" ? combatant.budget.movement + combatant.speed : combatant.budget.movement,
        },
        dodging: event.action === "dodge" ? true : combatant.dodging,
      }));
    case "attackDeclared": {
      const { attack } = event;
      const spent = updateCombatant(encounter, attack.attackerId, (combatant) => ({
        ...combatant,
        budget: { ...combatant.budget, action: false },
      }));
      return {
        ...spent,
        attack,
        sequence: spent.sequence + 1,
        pendingRolls: { ...spent.pendingRolls, [attack.attackRollId]: { purpose: "attack", attackId: attack.id } },
      };
    }
    case "attackRolled":
      return encounter.attack?.id === event.attackId
        ? withoutPending({ ...encounter, attack: { ...encounter.attack, critical: event.critical } }, encounter.attack.attackRollId)
        : encounter;
    case "damageRollRequested":
      return encounter.attack?.id === event.attackId
        ? {
            ...encounter,
            attack: { ...encounter.attack, stage: "damageRoll", damageRollId: event.rollId },
            sequence: encounter.sequence + 1,
            pendingRolls: { ...encounter.pendingRolls, [event.rollId]: { purpose: "damage", attackId: event.attackId } },
          }
        : encounter;
    case "damageRolled":
      return encounter.attack?.damageRollId == null ? encounter : withoutPending(encounter, encounter.attack.damageRollId);
    case "combatantHpChanged": {
      const updated = updateCombatant(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        hp: event.hp,
        condition: event.condition,
        deathSaves: event.deathSaves,
      }));
      return event.condition === "dead" ? withoutEngagements(updated, event.combatantId) : updated;
    }
    case "attackFinished":
      return encounter.attack?.id === event.attackId ? { ...encounter, attack: null } : encounter;
    case "deathSaveRequested":
      return {
        ...encounter,
        sequence: encounter.sequence + 1,
        pendingRolls: { ...encounter.pendingRolls, [event.rollId]: { purpose: "deathSave", combatantId: event.combatantId } },
      };
    case "deathSaveRolled": {
      const updated = updateCombatant(withoutPending(encounter, event.rollId), event.combatantId, (combatant) => ({
        ...combatant,
        hp: event.hp,
        condition: event.condition,
        deathSaves: event.deathSaves,
      }));
      return event.condition === "dead" ? withoutEngagements(updated, event.combatantId) : updated;
    }
    case "combatantFled":
      return updateCombatant(withoutEngagements(encounter, event.combatantId), event.combatantId, (combatant) => ({
        ...combatant,
        condition: "fled",
      }));
    case "turnEnded":
      return { ...encounter, turnEndsAt: null };
    case "turnDeferred":
      return { ...encounter, deferredTurn: { turnIndex: event.turnIndex, round: event.round } };
    case "encounterEnded":
      return { ...encounter, status: "ended", outcome: event.outcome, turnEndsAt: null, attack: null, pendingRolls: {} };
    default:
      return assertNever(event);
  }
}

function updateCombatant(encounter: EncounterState, id: CombatantId, update: (combatant: Combatant) => Combatant): EncounterState {
  const combatant = encounter.combatants[id];
  return combatant === undefined ? encounter : { ...encounter, combatants: { ...encounter.combatants, [id]: update(combatant) } };
}

function withoutEngagements(encounter: EncounterState, id: CombatantId): EncounterState {
  return { ...encounter, engagements: encounter.engagements.filter(([a, b]) => a !== id && b !== id) };
}

function withoutPending(encounter: EncounterState, rollId: string): EncounterState {
  const { [rollId]: _removed, ...pendingRolls } = encounter.pendingRolls;
  return { ...encounter, pendingRolls };
}
