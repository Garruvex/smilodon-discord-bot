import { encounterSpec, findClock, findClue, findEncounter, storyEffectOf, withArrival, type AdventureBible, type BibleEffect, type BibleInteraction, type BiblePartyEffect } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import type { EffectCondition, PartyEffect, PlannedAction, PlannedEffect, RoundPlanProposal } from "../../../domain/campaign/commands/campaign-command.js";
import { dcLadder, type DcTier } from "../../../domain/campaign/rules/difficulty.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { PlannerProposal, PlannerRequest } from "../ports/dm-ports.js";
import { availableInteractions, doneFlag, goldOf, reachableScenes, triedFlag, type Wallet } from "./interactions.js";

// The IDs a proposal's story effects may name right now.
export function plannerStory(bible: AdventureBible, state: CampaignState): PlannerRequest["story"] {
  const sceneIds = reachableScenes(bible, state);
  // A proposed move has not passed the table vote. Until it settles, only the
  // current scene's encounters, clocks, clues and interactions may be planned.
  const votedMove = state.pendingMove ?? (state.sceneMoveSettledRound === state.lastRoundNumber && state.sceneMoveSettledDestination != null ? { sceneId: state.sceneMoveSettledDestination } : undefined);
  const moveNotYetResolved = state.pendingMove !== undefined;
  const here = new Set<string>([...(state.sceneId === null ? [] : [state.sceneId]), ...(votedMove === undefined || moveNotYetResolved ? [] : [votedMove.sceneId])]);
  const canResolveScene = (sceneId: string): boolean => sceneId === state.sceneId || (!moveNotYetResolved && votedMove?.sceneId === sceneId);
  return {
    sceneId: state.sceneId,
    ...(state.pendingMove === undefined ? {} : { pendingMoveTo: state.pendingMove.sceneId }),
    sceneIds,
    encounters: bible.encounters
      .filter((encounter) => here.has(encounter.sceneId) && !state.encounterHistory.includes(encounter.id))
      .map((encounter) => ({ id: encounter.id, sceneId: encounter.sceneId })),
    clocks: bible.clocks.filter((clock) => here.has(clock.sceneId)).map((clock) => ({
      id: clock.id,
      sceneId: clock.sceneId,
      filled: state.clocks[clock.id]?.filled ?? 0,
      segments: clock.segments,
    })),
    clues: bible.clues.filter((clue) => here.has(clue.sceneId) && !state.clues.some((known) => known.id === clue.id)).map((clue) => ({ id: clue.id, sceneId: clue.sceneId })),
    interactions: availableInteractions(bible, state).filter((interaction) => canResolveScene(interaction.sceneId)).map((interaction) => ({ id: interaction.id, sceneId: interaction.sceneId, label: interaction.label })),
  };
}

// Turns authored IDs into what the engine applies: a scene ID it can store
// and the encounter's full definition. Unknown or out-of-place IDs are
// problems for the Planner's retry, like the engine's own (plan §6: unknown
// encounter IDs are rejected).
// The table's rules the resolution depends on: whose gold pays (the loot-gold house rule) and where chance comes from (a table on the
// page; the result is written into the plan, so it is decided once and the log shows it).
export interface ResolveOptions {
  readonly wallet: Wallet;
  readonly random?: () => number;
}

export function resolveStoryEffects(
  proposal: PlannerProposal,
  bible: AdventureBible,
  state: CampaignState,
  options: ResolveOptions = { wallet: "pool" },
): { readonly kind: "resolved"; readonly proposal: RoundPlanProposal } | { readonly kind: "invalid"; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const effects: PlannedEffect[] = [];
  const moveNotYetResolved = state.pendingMove !== undefined;
  // A fight may be in the current scene or a destination approved before this round.
  const settledDestination = state.sceneMoveSettledRound === state.lastRoundNumber ? state.sceneMoveSettledDestination : undefined;
  const reachable = new Set<string>([...(state.sceneId === null ? [] : [state.sceneId]), ...(settledDestination == null ? [] : [settledDestination])]);
  for (const effect of proposal.effects) if (effect.kind === "transitionScene") reachable.add(effect.sceneId);
  const exits = new Set(reachableScenes(bible, state));
  // The scene the model moves the party to: what is set there (its fight, clock or clue) waits with the move.
  const movedTo = proposal.effects.find((effect) => effect.kind === "transitionScene" && effect.sceneId !== state.sceneId && exits.has(effect.sceneId));
  const arrival = movedTo?.kind === "transitionScene" ? bible.scenes.find((scene) => scene.id === movedTo.sceneId)?.id : settledDestination ?? undefined;
  const arrivesWith = (sceneId: string): Partial<Pick<PlannedEffect, "arrivalOf">> => (arrival !== undefined && sceneId === arrival ? { arrivalOf: arrival } : {});

  // An authored interaction that moves the party or starts a fight already says so; the model's own proposal of the same kind
  // would be a second one, which the engine refuses (one scene change and one fight per round), so the authored one stands.
  const resolvedInteractions = resolveInteractions(proposal, bible, state, options, problems);
  const authored = new Set(resolvedInteractions.interactionEffects.map(({ effect }) => effect.kind));

  for (const effect of proposal.effects) {
    if ((effect.kind === "transitionScene" || effect.kind === "startEncounter") && authored.has(effect.kind)) continue;
    switch (effect.kind) {
      case "transitionScene": {
        const scene = bible.scenes.find((candidate) => candidate.id === effect.sceneId);
        if (scene === undefined) problems.push(`Unknown scene "${effect.sceneId}".`);
        else if (scene.id === state.sceneId) problems.push(`The party is already in ${scene.id}; drop the transition.`);
        else if (!exits.has(scene.id)) problems.push(`${scene.id} cannot be reached from ${state.sceneId ?? "here"}; the way on is ${[...exits].join(", ") || "closed"}.`);
        // The model's move waits for the table, with the effects of arriving; an authored one (below) happens at once.
        else effects.push(...withArrival({ kind: "transitionScene", sceneId: scene.id }, bible).map((planned) => ({ effect: planned, when: effect.when, ...(planned.kind === "transitionScene" ? (effect.movers === undefined ? {} : { movers: effect.movers }) : { arrivalOf: scene.id }) })));
        break;
      }
      case "startEncounter": {
        const encounter = findEncounter(bible, effect.encounterId);
        if (encounter === undefined) problems.push(`Unknown encounter "${effect.encounterId}".`);
        // A fight that is already over or belongs to another scene is left out rather than holding the round: the players' actions still resolve.
        else if (state.encounterHistory.includes(encounter.id) || !reachable.has(encounter.sceneId) || (moveNotYetResolved && state.pendingMove?.sceneId === encounter.sceneId)) break;
        else effects.push({ effect: { kind: "startEncounter", encounter: encounterSpec(encounter, bible) }, when: effect.when, ...(encounter.sceneId === state.pendingMove?.sceneId ? { arrivalOf: encounter.sceneId } : arrivesWith(encounter.sceneId)) });
        break;
      }
      case "advanceClock": {
        const clock = findClock(bible, effect.clockId);
        if (clock === undefined) problems.push(`Unknown clock "${effect.clockId}".`);
        else if (!reachable.has(clock.sceneId)) break;
        else if (!Number.isInteger(effect.by) || effect.by < 1 || effect.by > 3) problems.push(`${clock.id} may advance by 1 to 3 segments.`);
        else effects.push({ effect: clockEffect(bible, state, clock.id, effect.by), when: effect.when, ...arrivesWith(clock.sceneId) });
        break;
      }
      case "revealClue": {
        const clue = findClue(bible, effect.clueId);
        if (clue === undefined) problems.push(`Unknown clue "${effect.clueId}".`);
        else if (state.clues.some((known) => known.id === clue.id) || !reachable.has(clue.sceneId)) break;
        else effects.push({ effect: { kind: "revealClue", clueId: clue.id, text: clue.publicText }, when: effect.when, ...arrivesWith(clue.sceneId) });
        break;
      }
      default:
        problems.push("Unknown story effect.");
    }
  }

  const { actions, interactionEffects } = resolvedInteractions;
  effects.push(...interactionEffects);
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "resolved", proposal: { roundNumber: proposal.roundNumber, actions, effects } };
}

// The heroes that chose an authored interaction get its check and DC in place of the model's; each interaction's results are
// hung on its heroes' checks once, however many attempted it.
function resolveInteractions(
  proposal: PlannerProposal,
  bible: AdventureBible,
  state: CampaignState,
  options: ResolveOptions,
  problems: string[],
): { readonly actions: readonly PlannedAction[]; readonly interactionEffects: readonly PlannedEffect[] } {
  const available = new Map(availableInteractions(bible, state).map((interaction) => [interaction.id as string, interaction]));
  const attempts = new Map<string, { readonly interaction: BibleInteraction; readonly heroes: string[] }>();
  const actions: PlannedAction[] = proposal.actions.map((action) => {
    const plain: PlannedAction = { characterId: action.characterId, resolution: action.resolution };
    const id = action.interactionId ?? null;
    if (id === null || action.resolution.kind === "impossible") return plain;
    const interaction = available.get(id);
    if (interaction === undefined) {
      problems.push(`${action.characterId}: ${id} is not an interaction available here now; use null for it.`);
      return plain;
    }
    if (interaction.pay > 0 && goldOf(state, action.characterId, options.wallet) < interaction.pay) {
      problems.push(`${action.characterId} cannot pay the ${interaction.pay} gold ${id} costs; plan something else.`);
      return plain;
    }
    const group = attempts.get(id) ?? { interaction, heroes: [] };
    group.heroes.push(action.characterId);
    attempts.set(id, group);
    const { check } = interaction;
    if (check === null) return { characterId: action.characterId, resolution: { kind: "automatic", reason: interaction.label } };
    const test: CheckTest = check.skill !== undefined ? { kind: "skill", skill: check.skill as never } : { kind: check.save === true ? "save" : "ability", ability: check.ability as never };
    const reasons = action.resolution.kind === "check" ? action.resolution.rollModeReasons : [];
    return { characterId: action.characterId, resolution: { kind: "check", test, dcTier: nearestTier(check.dc), dc: check.dc, rollModeReasons: reasons } };
  });

  for (const id of proposal.worldSteps ?? []) {
    const step = available.get(id);
    if (step !== undefined && !attempts.has(id)) attempts.set(id, { interaction: { ...step, check: null, pay: 0 }, heroes: [] });
  }
  const interactionEffects: PlannedEffect[] = [];
  const random = options.random ?? Math.random;
  for (const { interaction, heroes } of attempts.values()) {
    const rolled = interaction.check !== null;
    const success: EffectCondition = rolled ? { kind: "anyCheck", characterIds: heroes, success: true } : { kind: "always" };
    const failure: EffectCondition = { kind: "anyCheck", characterIds: heroes, success: false };
    const always: EffectCondition = { kind: "always" };
    const tried = state.flags?.[triedFlag(interaction.id)] ?? 0;
    if (interaction.pay > 0) interactionEffects.push({ effect: { kind: "spendGold", characterId: heroes[0] ?? "", amount: interaction.pay }, when: always });
    interactionEffects.push({ effect: { kind: "setFlag", flag: triedFlag(interaction.id), value: tried + 1 }, when: always });
    interactionEffects.push({ effect: { kind: "setFlag", flag: doneFlag(interaction.id), value: 1 }, when: success });
    // Harm to the rollers follows each hero's own result, not the group's.
    const own = (branch: "success" | "failure" | number) => (characterId: string): EffectCondition =>
      !rolled
        ? always
        : branch === "failure"
          ? { kind: "checkOutcome", characterId, success: false }
          : typeof branch === "number"
            ? { kind: "anyCheck", characterIds: [characterId], success: true, atLeast: branch }
            : { kind: "checkOutcome", characterId, success: true };
    const add = (list: readonly BibleEffect[], when: EffectCondition, perHero: (characterId: string) => EffectCondition, scope: string): void => {
      list.forEach((effect, index) => {
        interactionEffects.push(...plannedEffects(effect, `${interaction.id}:${scope}:${index}`, { bible, state, random, problems, heroes, when, perHero }));
      });
    };
    add(interaction.onSuccess, success, own("success"), "s");
    if (rolled) add(interaction.onFailure, failure, own("failure"), "f");
    interaction.tiers.forEach((tier, index) => add(tier.effects, { kind: "anyCheck", characterIds: heroes, success: true, atLeast: tier.dc }, own(tier.dc), `t${index}`));
  }
  return { actions, interactionEffects };
}

interface EffectContext {
  readonly bible: AdventureBible;
  readonly state: CampaignState;
  readonly random: () => number;
  readonly problems: string[];
  // The heroes who took the attempt, the condition the effect hangs on, and the condition for one hero alone.
  readonly heroes: readonly string[];
  readonly when: EffectCondition;
  readonly perHero: (characterId: string) => EffectCondition;
}

// One authored effect as planned effects, each with the condition it fires on; nothing when it no longer applies (a clue already
// known, a fight already fought). A random table is decided here, once, and the choice is what the plan carries.
function plannedEffects(effect: BibleEffect, scopeId: string, context: EffectContext): readonly PlannedEffect[] {
  const { bible, state, problems, when } = context;
  const moveNotYetResolved = state.pendingMove !== undefined;
  switch (effect.kind) {
    case "random": {
      const weights = effect.options.map((option) => option.weight ?? 1);
      let roll = context.random() * weights.reduce((sum, weight) => sum + weight, 0);
      const picked = weights.findIndex((weight) => (roll -= weight) < 0);
      const option = effect.options[picked < 0 ? weights.length - 1 : picked];
      return (option?.effects ?? []).flatMap((inner, index) => plannedEffects(inner, `${scopeId}:o${picked}:${index}`, context));
    }
    case "hurt": {
      const targets = effect.who === "party" ? Object.keys(state.characters) : context.heroes;
      return targets.map((characterId) => ({
        effect: { kind: "hurt" as const, characterId, count: effect.count, sides: effect.sides, damageType: effect.damageType },
        when: effect.who === "party" ? when : context.perHero(characterId),
      }));
    }
    case "reveal": {
      const clue = findClue(bible, effect.clue);
      if (clue === undefined) problems.push(`Unknown clue "${effect.clue}".`);
      return clue === undefined || state.clues.some((known) => known.id === clue.id) || (moveNotYetResolved && state.pendingMove?.sceneId === clue.sceneId) ? [] : [{ effect: { kind: "revealClue", clueId: clue.id, text: clue.publicText }, when }];
    }
    case "goto":
      return effect.scene === state.sceneId ? [] : withArrival({ kind: "transitionScene", sceneId: effect.scene }, bible).map((planned) => ({ effect: planned, when, ...(planned.kind === "transitionScene" ? { forced: true } : {}) }));
    case "encounter": {
      const encounter = findEncounter(bible, effect.encounter);
      if (encounter === undefined) problems.push(`Unknown encounter "${effect.encounter}".`);
      return encounter === undefined || state.encounterHistory.includes(encounter.id) || (moveNotYetResolved && state.pendingMove?.sceneId === encounter.sceneId) ? [] : [{ effect: { kind: "startEncounter", encounter: encounterSpec(encounter, bible) }, when, ...(encounter.sceneId === state.pendingMove?.sceneId ? { arrivalOf: encounter.sceneId } : {}) }];
    }
    case "clock": {
      const clock = findClock(bible, effect.clock);
      if (clock === undefined) problems.push(`Unknown clock "${effect.clock}".`);
      return clock === undefined ? [] : [{ effect: clockEffect(bible, state, clock.id, effect.by), when }];
    }
    default: {
      const party: PartyEffect | null = storyEffectOf(effect satisfies BiblePartyEffect, scopeId, bible);
      return party === null ? [] : [{ effect: party, when }];
    }
  }
}

function clockEffect(bible: AdventureBible, state: CampaignState, clockId: string, by: number): Extract<PlannedEffect["effect"], { kind: "advanceClock" }> {
  const clock = findClock(bible, clockId);
  const fight = findEncounter(bible, clock?.onFull ?? null);
  const onFull = fight === undefined || state.encounterHistory.includes(fight.id) ? null : encounterSpec(fight, bible);
  return { kind: "advanceClock", clockId, segments: clock?.segments ?? 2, by, onFull };
}

// The ladder tier closest to an authored DC (the check itself keeps the exact DC).
function nearestTier(dc: number): DcTier {
  const tiers = Object.entries(dcLadder) as [DcTier, number][];
  return tiers.reduce((best, tier) => (Math.abs(tier[1] - dc) < Math.abs(best[1] - dc) ? tier : best))[0];
}


