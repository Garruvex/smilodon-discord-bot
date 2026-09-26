import { assertNever } from "../core/assert-never.js";
import type { CombatEvent } from "./combat-events.js";
import type { Combatant, CombatantId, EncounterState, ResolutionState } from "./combat-state.js";

const prone = "condition:prone";

// Applies one combat event to the encounter. Pure and total, like evolve().
export function evolveEncounter(encounter: EncounterState | null, event: CombatEvent): EncounterState | null {
  if (event.kind === "encounterStarted") return event.encounter;
  if (encounter === null) return null;
  switch (event.kind) {
    case "initiativeRolled":
      return withoutPending(
        update(encounter, event.combatantId, (combatant) => ({ ...combatant, initiative: event.roll.total })),
        [event.rollId],
      );
    case "turnOrderSet":
      return { ...encounter, status: "active", order: event.order, round: 1, turnIndex: 0 };
    case "turnStarted": {
      // Sneak Attack is once per turn, whoever's turn it is.
      const combatants: Record<CombatantId, Combatant> = {};
      for (const [id, combatant] of Object.entries(encounter.combatants)) combatants[id] = { ...combatant, sneakAttackUsed: false };
      return update(
        {
          ...encounter,
          combatants,
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
          disengaged: false,
        }),
      );
    }
    case "stoodUp":
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        conditions: combatant.conditions.filter((condition) => condition !== prone),
        budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet },
      }));
    case "combatantMoved":
      return update(withoutEngagements(encounter, event.combatantId), event.combatantId, (combatant) => ({
        ...combatant,
        zoneId: event.zoneId,
        budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet },
      }));
    case "combatantEngaged":
      return update(
        { ...encounter, engagements: [...encounter.engagements, [event.combatantId, event.targetId] as const] },
        event.combatantId,
        (combatant) => ({ ...combatant, budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet } }),
      );
    case "combatantWithdrew":
      return update(withoutEngagements(encounter, event.combatantId), event.combatantId, (combatant) => ({
        ...combatant,
        budget: { ...combatant.budget, movement: combatant.budget.movement - event.feet },
      }));
    case "gearChanged":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, armorClass: event.armorClass, attacks: event.attacks, traits: event.traits }));
    case "combatNarrationRecorded":
      return { ...encounter, narratedRound: Math.max(encounter.narratedRound, event.round) };
    case "moveInterrupted":
      return { ...encounter, pendingMove: event.move };
    case "moveCleared":
      return { ...encounter, pendingMove: null };
    case "actionTaken":
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        budget: {
          ...combatant.budget,
          action: event.bonus ? combatant.budget.action : false,
          bonusAction: event.bonus ? false : combatant.budget.bonusAction,
          movement: event.action === "dash" ? combatant.budget.movement + combatant.speed : combatant.budget.movement,
        },
        dodging: event.action === "dodge" ? true : combatant.dodging,
        disengaged: event.action === "disengage" ? true : combatant.disengaged,
      }));
    case "resolutionDeclared": {
      const { resolution, cost } = event;
      const spent = update(encounter, resolution.actorId, (combatant) => {
        const slots = { ...combatant.resources.spellSlots };
        if (cost.spellSlot !== null) slots[cost.spellSlot] = Math.max(0, (slots[cost.spellSlot] ?? 0) - 1);
        const uses = { ...combatant.resources.featureUses };
        if (cost.featureUse !== null) uses[cost.featureUse] = Math.max(0, (uses[cost.featureUse] ?? 0) - 1);
        return {
          ...combatant,
          budget: {
            ...combatant.budget,
            action: cost.action ? false : combatant.budget.action,
            bonusAction: cost.bonusAction ? false : combatant.budget.bonusAction,
            reaction: cost.reaction ? false : combatant.budget.reaction,
          },
          resources: { spellSlots: slots, featureUses: uses },
        };
      });
      return { ...spent, resolution, sequence: event.sequence, pendingRolls: { ...spent.pendingRolls, ...event.pendingRolls } };
    }
    case "checkRolled":
      return withoutPending(
        updateResolution(encounter, event.resolutionId, (resolution) => ({
          ...resolution,
          outcomes: { ...resolution.outcomes, [event.targetId]: { landed: event.landed, critical: event.critical } },
        })),
        [event.rollId],
      );
    case "effectRollsRequested": {
      const pending = Object.fromEntries(
        Object.keys(event.rolls).map((rollId) => [rollId, { purpose: "effect", resolutionId: event.resolutionId } as const]),
      );
      return {
        ...updateResolution(encounter, event.resolutionId, (resolution) => ({
          ...resolution,
          stage: "effects",
          effectRolls: { ...resolution.effectRolls, ...event.rolls },
        })),
        sequence: event.sequence,
        pendingRolls: { ...encounter.pendingRolls, ...pending },
      };
    }
    case "effectRolled":
      return withoutPending(
        updateResolution(encounter, event.resolutionId, (resolution) => ({
          ...resolution,
          rolled: { ...resolution.rolled, [event.effectKey]: event.value },
        })),
        [event.rollId],
      );
    case "combatantHpChanged": {
      const updated = update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        hp: event.hp,
        condition: event.condition,
        deathSaves: event.deathSaves,
      }));
      return event.condition === "dead" ? withoutEngagements(updated, event.combatantId) : updated;
    }
    case "conditionAdded":
      return update(encounter, event.combatantId, (combatant) =>
        combatant.conditions.includes(event.condition) ? combatant : { ...combatant, conditions: [...combatant.conditions, event.condition] },
      );
    case "effectAdded":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, effects: [...combatant.effects, event.effect] }));
    case "effectsRemoved":
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        effects: combatant.effects.filter((effect) => !event.effectIds.includes(effect.id)),
      }));
    case "sneakAttackUsed":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, sneakAttackUsed: true }));
    case "concentrationStarted":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, concentration: event.concentration }));
    case "concentrationEnded":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, concentration: null }));
    case "concentrationSaveRequested":
    case "deathSaveRequested":
      return { ...encounter, sequence: event.sequence, pendingRolls: { ...encounter.pendingRolls, [event.rollId]: event.pending } };
    case "concentrationSaveRolled":
      return withoutPending(encounter, [event.rollId]);
    case "resolutionFinished":
      return encounter.resolution?.id === event.resolutionId ? { ...encounter, resolution: null } : encounter;
    case "deathSaveRolled": {
      const updated = update(withoutPending(encounter, [event.rollId]), event.combatantId, (combatant) => ({
        ...combatant,
        hp: event.hp,
        condition: event.condition,
        deathSaves: event.deathSaves,
      }));
      return event.condition === "dead" ? withoutEngagements(updated, event.combatantId) : updated;
    }
    case "combatantFled":
      return update(withoutEngagements(encounter, event.combatantId), event.combatantId, (combatant) => ({ ...combatant, condition: "fled" }));
    case "turnEnded":
      return { ...encounter, turnEndsAt: null };
    case "turnDeferred":
      return { ...encounter, deferredTurn: { turnIndex: event.turnIndex, round: event.round } };
    case "encounterEnded":
      return {
        ...encounter,
        status: "ended",
        outcome: event.outcome,
        turnEndsAt: null,
        resolution: null,
        pendingMove: null,
        pendingRolls: {},
      };
    default:
      return assertNever(event);
  }
}

function update(encounter: EncounterState, id: CombatantId, change: (combatant: Combatant) => Combatant): EncounterState {
  const combatant = encounter.combatants[id];
  return combatant === undefined ? encounter : { ...encounter, combatants: { ...encounter.combatants, [id]: change(combatant) } };
}

function updateResolution(
  encounter: EncounterState,
  id: string,
  change: (resolution: ResolutionState) => ResolutionState,
): EncounterState {
  return encounter.resolution?.id === id ? { ...encounter, resolution: change(encounter.resolution) } : encounter;
}

function withoutEngagements(encounter: EncounterState, id: CombatantId): EncounterState {
  return { ...encounter, engagements: encounter.engagements.filter(([a, b]) => a !== id && b !== id) };
}

function withoutPending(encounter: EncounterState, rollIds: readonly string[]): EncounterState {
  const pendingRolls = { ...encounter.pendingRolls };
  for (const rollId of rollIds) delete pendingRolls[rollId];
  return { ...encounter, pendingRolls };
}
