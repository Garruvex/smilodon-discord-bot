import { assertNever } from "../core/assert-never.js";
import type { EffectInstance } from "../effects/effect-instance.js";
import { attacksPerAction, deathBurstKey, indomitableKey, relentlessRageKey, legendaryActionsKey, legendaryResistanceKey, relentlessEnduranceKey } from "../rules/traits.js";
import { wildShapeUses } from "../rules/wild-shape-rules.js";
import type { CombatEvent } from "./combat-events.js";
import { innateUseKey, usePoolOf } from "../magic/spell-rules.js";
import { spendSlot, type Combatant, type CombatantId, type EncounterState, type ResolutionState } from "./combat-state.js";

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
            movement: event.movement ?? combatant.speed,
            attacksLeft: attacksPerAction(combatant.traits),
            bonusSpellCast: false,
          },
          dodging: false,
          disengaged: false,
          // Its legendary actions come back at the start of its own turn.
          resources: renewLegendaryActions(combatant),
          cooldowns: Object.fromEntries(Object.entries(combatant.cooldowns).map(([id, turns]) => [id, Math.max(0, turns - 1)])),
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
    case "opportunityAttackOffered":
      return encounter.pendingMove === null ? encounter : { ...encounter, pendingMove: { ...encounter.pendingMove, offer: { closesAt: event.closesAt } } };
    case "opportunityAttackAnswered":
      return encounter.pendingMove === null ? encounter : { ...encounter, pendingMove: { ...encounter.pendingMove, offer: null } };
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
        const resources = cost.spellSlot !== null ? spendSlot(combatant.resources, cost.spellSlot) : combatant.resources;
        const uses = { ...resources.featureUses };
        if (cost.featureUse !== null) uses[cost.featureUse] = Math.max(0, (uses[cost.featureUse] ?? 0) - (cost.featureUseAmount ?? 1));
        // An innate spell cast a number of times a day uses one of them up.
        if (resolution.source.kind === "spell") {
          const innate = combatant.spellcasting?.innate?.[resolution.source.spellId];
          const pool = usePoolOf(combatant.spellcasting, resolution.source.spellId);
          if (typeof innate === "number") uses[pool.key] = Math.max(0, (uses[pool.key] ?? innate) - pool.cost);
        }
        const cooldowns = resolution.source.kind === "area" ? { ...combatant.cooldowns, [resolution.source.area.weapon]: resolution.source.area.cooldown } : combatant.cooldowns;
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
            bonusSpellCast: combatant.budget.bonusSpellCast || (resolution.source.kind === "spell" && cost.bonusAction),
          },
          resources: { ...resources, featureUses: uses },
          cooldowns,
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
    case "checkRerolled": {
      const replaced = updateResolution(encounter, event.resolutionId, (resolution) => {
        const check = resolution.checks[event.oldRollId];
        if (check === undefined) return resolution;
        const { [event.oldRollId]: _old, ...others } = resolution.checks;
        return { ...resolution, checks: { ...others, [event.rollId]: check }, rerolled: [...(resolution.rerolled ?? []), event.rollId] };
      });
      const { [event.oldRollId]: _gone, ...pending } = replaced.pendingRolls;
      return { ...replaced, pendingRolls: { ...pending, [event.rollId]: { purpose: "check", resolutionId: event.resolutionId } } };
    }
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
        ...(event.tempHp === undefined ? {} : { tempHp: event.tempHp }),
        condition: event.condition,
        deathSaves: event.deathSaves,
      }));
      return event.condition === "dead" ? withoutEngagements(updated, event.combatantId) : updated;
    }
    case "reactionOffered":
      return withoutPending(
        updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, reaction: event.reaction, reactionsAsked: [...(resolution.reactionsAsked ?? []), event.reaction.rollId] })),
        [event.reaction.rollId],
      );
    case "spellCountered":
      return withoutPending(
        updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, checks: {} })),
        Object.keys(encounter.resolution?.id === event.resolutionId ? encounter.resolution.checks : {}),
      );
    case "reactionAnswered": {
      const answered = updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, reaction: null }));
      if (event.spellId === null || event.slotLevel === null) return answered;
      const slotLevel = event.slotLevel;
      // Casting spends the reaction and a spell slot.
      return update(answered, event.targetId, (combatant) => ({
        ...combatant,
        budget: { ...combatant.budget, reaction: false },
        resources: spendSlot(combatant.resources, slotLevel),
      }));
    }
    // The roll that triggered this is already off pendingRolls (checkRolled
    // cleared it before offering smite); nothing else to remove here.
    case "smiteOffered":
      return updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, smite: event.smite }));
    case "smiteAnswered": {
      const answered = updateResolution(encounter, event.resolutionId, (resolution) => ({ ...resolution, smite: null, smiteSlot: event.slotLevel }));
      if (event.slotLevel === null) return answered;
      const slotLevel = event.slotLevel;
      // Divine Smite spends its slot when the choice is made, not when declared.
      return update(answered, event.combatantId, (combatant) => ({ ...combatant, resources: spendSlot(combatant.resources, slotLevel) }));
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
    case "terrainChanged":
      return { ...encounter, zones: encounter.zones.map((zone) => (zone.id === event.zoneId ? { ...zone, difficult: event.difficult } : zone)) };
    case "lightingChanged":
      return { ...encounter, zones: encounter.zones.map((zone) => (zone.id === event.zoneId ? { ...zone, lighting: event.lighting } : zone)) };
    case "slotGained":
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        resources: { ...combatant.resources, spellSlots: { ...combatant.resources.spellSlots, [event.level]: (combatant.resources.spellSlots[event.level] ?? 0) + 1 } },
      }));
    case "slotConverted":
      // The points cannot pass the pool's maximum, which is the sorcerer's level.
      return update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        resources: {
          ...combatant.resources,
          spellSlots: { ...combatant.resources.spellSlots, [event.level]: Math.max(0, (combatant.resources.spellSlots[event.level] ?? 0) - 1) },
          featureUses: { ...combatant.resources.featureUses, "feature:font-of-magic": Math.min(combatant.level, (combatant.resources.featureUses["feature:font-of-magic"] ?? 0) + event.level) },
        },
      }));
    case "movementGranted":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, budget: { ...combatant.budget, movement: combatant.budget.movement + event.feet } }));
    case "actionGranted":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, budget: event.attacks === undefined ? { ...combatant.budget, action: true, attacksLeft: attacksPerAction(combatant.traits) } : { ...combatant.budget, attacksLeft: combatant.budget.attacksLeft + event.attacks } }));
    case "monsterStateChanged":
      return update(encounter, event.combatantId, (combatant) => {
        const uses = { ...combatant.resources.featureUses };
        if (event.legendaryResistanceSpent === true) uses[legendaryResistanceKey] = Math.max(0, (uses[legendaryResistanceKey] ?? 0) - 1);
        if (event.relentlessSpent === true) uses[relentlessEnduranceKey] = 0;
        if (event.relentlessRageSpent === true) uses[relentlessRageKey] = 0;
        if (event.burstSpent === true) uses[deathBurstKey] = 0;
        if (event.featureSpent !== undefined) uses[event.featureSpent] = Math.max(0, (uses[event.featureSpent] ?? 0) - 1);
        if (event.innateSpent !== undefined) uses[innateUseKey(event.innateSpent)] = Math.max(0, (uses[innateUseKey(event.innateSpent)] ?? combatant.spellcasting?.innate?.[event.innateSpent] ?? 0) - 1);
        if (event.indomitableSpent === true) uses[indomitableKey] = Math.max(0, (uses[indomitableKey] ?? 0) - 1);
        if (event.legendarySpent !== undefined) uses[legendaryActionsKey] = Math.max(0, (uses[legendaryActionsKey] ?? 0) - event.legendarySpent);
        return {
          ...combatant,
          regenBlocked: event.regenBlocked ?? combatant.regenBlocked,
          legendaryTurn: event.legendaryTurn ?? combatant.legendaryTurn,
          resources: { ...combatant.resources, featureUses: uses },
        };
      });
    case "exhaustionChanged": {
      const updated = update(encounter, event.combatantId, (combatant) => ({
        ...combatant,
        exhaustion: event.level,
        condition: event.level >= 6 ? "dead" : combatant.condition,
      }));
      return event.level >= 6 ? withoutEngagements(updated, event.combatantId) : updated;
    }
    case "uncannyDodgeUsed":
      return update(encounter, event.combatantId, (combatant) => ({ ...combatant, budget: { ...combatant.budget, reaction: false } }));
    case "wildShapeChanged":
      return update(encounter, event.combatantId, ({ boundTo: _held, ...combatant }) => ({
        ...combatant,
        ...(event.boundTo === undefined ? {} : { boundTo: event.boundTo }),
        attacks: event.attacks,
        armorClass: event.armorClass,
        speed: event.speed,
        traits: event.traits,
        maxHp: event.maxHp,
        hp: event.hp,
        wildShapeOriginal: event.original,
        resources:
          event.spendsUseOf === undefined
            ? combatant.resources
            : { ...combatant.resources, featureUses: { ...combatant.resources.featureUses, [event.spendsUseOf]: Math.max(0, (combatant.resources.featureUses[event.spendsUseOf] ?? wildShapeUses) - 1) } },
      }));
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
    case "combatantSummoned": {
      const at = encounter.order.indexOf(event.summonerId) + 1;
      const order = [...encounter.order.slice(0, at), event.combatant.id, ...encounter.order.slice(at)];
      return { ...encounter, combatants: { ...encounter.combatants, [event.combatant.id]: event.combatant }, order, turnIndex: at <= encounter.turnIndex ? encounter.turnIndex + 1 : encounter.turnIndex };
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

// A monster with legendary actions has all of them again at the start of its own turn.
function renewLegendaryActions(combatant: Combatant): Combatant["resources"] {
  const uses = combatant.traits.reduce((most, trait) => (trait.kind === "legendaryActions" ? Math.max(most, trait.uses) : most), 0);
  return uses === 0 ? combatant.resources : { ...combatant.resources, featureUses: { ...combatant.resources.featureUses, [legendaryActionsKey]: uses } };
}
