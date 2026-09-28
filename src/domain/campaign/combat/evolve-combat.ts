import { assertNever } from "../core/assert-never.js";
import type { EffectInstance } from "../effects/effect-instance.js";
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
          budget: {
            action: true,
            bonusAction: true,
            reaction: true,
            movement: combatant.speed,
            attacksLeft: combatant.traits.reduce((most, trait) => (trait.kind === "extraAttack" ? Math.max(most, trait.attacks) : most), 1),
          },
          dodging: false,
          disengaged: false,
        }),
      );
    }
    case "stoodUp":
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        effects: combatant.effects.filter((effect) => effect.definition !== prone),
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
          // Spending the action on something other than an attack (or all of
          // it on a bonus action) owes no more attacks from Extra Attack.
          attacksLeft: event.bonus ? combatant.budget.attacksLeft : 0,
        },
        dodging: event.action === "dodge" ? true : combatant.dodging,
        disengaged: event.action === "disengage" ? true : combatant.disengaged,
      }));
    case "resolutionDeclared": {
      const { resolution, cost } = event;
      // Extra Attack: a weapon attack taken as the Attack action spends one
      // of the turn's attacksLeft instead of the action itself; only the
      // last of them (cost.action true) actually spends the action. Spending
      // the action on anything else (a spell, a feature) owes no more attacks.
      const spendsAnAttack = resolution.source.kind === "weapon" && resolution.purpose === "action";
      const spent = update(encounter, resolution.actorId, (combatant) => {
        const slots = { ...combatant.resources.spellSlots };
        if (cost.spellSlot !== null) slots[cost.spellSlot] = Math.max(0, (slots[cost.spellSlot] ?? 0) - 1);
        const uses = { ...combatant.resources.featureUses };
        if (cost.featureUse !== null) uses[cost.featureUse] = Math.max(0, (uses[cost.featureUse] ?? 0) - 1);
        const attacksLeft = spendsAnAttack
          ? Math.max(0, combatant.budget.attacksLeft - 1)
          : cost.action
            ? 0
            : combatant.budget.attacksLeft;
        return {
          ...combatant,
          budget: {
            ...combatant.budget,
            action: cost.action ? false : combatant.budget.action,
            bonusAction: cost.bonusAction ? false : combatant.budget.bonusAction,
            reaction: cost.reaction ? false : combatant.budget.reaction,
            attacksLeft,
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
    case "reactionOffered":
      return withoutPending(updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, reaction: event.reaction })), [event.reaction.rollId]);
    case "reactionAnswered": {
      const answered = updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, reaction: null }));
      if (event.spellId === null || event.slotLevel === null) return answered;
      const slotLevel = event.slotLevel;
      // Casting spends the reaction and a spell slot.
      return update(answered, event.targetId, (combatant) => ({
        ...combatant,
        budget: { ...combatant.budget, reaction: false },
        resources: { ...combatant.resources, spellSlots: { ...combatant.resources.spellSlots, [slotLevel]: Math.max(0, (combatant.resources.spellSlots[slotLevel] ?? 0) - 1) } },
      }));
    }
    case "triggersBegan":
      return { ...encounter, pendingTriggers: { creatureId: event.creatureId, boundary: event.boundary, done: [] } };
    case "triggerRollRequested":
      return {
        ...encounter,
        sequence: event.sequence,
        pendingRolls: { ...encounter.pendingRolls, [event.rollId]: event.pending },
        pendingTriggers:
          encounter.pendingTriggers === null ? null : { ...encounter.pendingTriggers, done: [...encounter.pendingTriggers.done, `${event.effectId}#${event.index}`] },
      };
    case "triggerRolled":
      return withoutPending(encounter, [event.rollId]);
    case "triggersFinished":
      return { ...encounter, pendingTriggers: null };
    case "effectApplied":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, effects: stack(combatant.effects, event.effect) }));
    case "effectsRemoved":
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        effects: combatant.effects.filter((effect) => !event.effectIds.includes(effect.id)),
      }));
    case "sneakAttackUsed":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, sneakAttackUsed: true }));
    // A 6th level of Exhaustion kills (SRD 5.1), same as any other death.
    case "exhaustionChanged": {
      const updated = update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        exhaustion: event.level,
        condition: event.level >= 6 ? "dead" : combatant.condition,
      }));
      return event.level >= 6 ? withoutEngagements(updated, event.combatantId) : updated;
    }
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
        pendingTriggers: null,
        pendingRolls: {},
      };
    default:
      return assertNever(event);
  }
}

// A new effect joins the ones a creature has, by its stacking rule: ignored when
// the creature already has that effect, replacing the one from the same source, or alongside.
function stack(effects: readonly EffectInstance[], added: EffectInstance): readonly EffectInstance[] {
  if (added.stacking === "ignore") return effects.some((effect) => effect.definition === added.definition) ? effects : [...effects, added];
  if (added.stacking === "replace") return [...effects.filter((effect) => !(effect.definition === added.definition && effect.sourceId === added.sourceId)), added];
  return [...effects, added];
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
