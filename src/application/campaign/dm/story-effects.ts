import { encounterSpec, findClock, findClue, findEncounter, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { PlannedEffect, RoundPlanProposal } from "../../../domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { PlannerProposal, PlannerRequest } from "../ports/dm-ports.js";

// The IDs a proposal's story effects may name right now.
export function plannerStory(bible: AdventureBible, state: CampaignState): PlannerRequest["story"] {
  return {
    sceneId: state.sceneId,
    sceneIds: bible.scenes.map((scene) => scene.id),
    encounters: bible.encounters
      .filter((encounter) => !state.encounterHistory.includes(encounter.id))
      .map((encounter) => ({ id: encounter.id, sceneId: encounter.sceneId })),
    clocks: bible.clocks.map((clock) => ({
      id: clock.id,
      sceneId: clock.sceneId,
      filled: state.clocks[clock.id]?.filled ?? 0,
      segments: clock.segments,
    })),
    clues: bible.clues.filter((clue) => !state.clues.some((known) => known.id === clue.id)).map((clue) => ({ id: clue.id, sceneId: clue.sceneId })),
  };
}

// Turns authored IDs into what the engine applies: a scene ID it can store
// and the encounter's full definition. Unknown or out-of-place IDs are
// problems for the Planner's retry, like the engine's own (plan §6: unknown
// encounter IDs are rejected).
export function resolveStoryEffects(
  proposal: PlannerProposal,
  bible: AdventureBible,
  state: CampaignState,
): { readonly kind: "resolved"; readonly proposal: RoundPlanProposal } | { readonly kind: "invalid"; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const effects: PlannedEffect[] = [];
  // A fight may be in the current scene or in the one this round moves to.
  const reachable = new Set<string>(state.sceneId === null ? [] : [state.sceneId]);
  for (const effect of proposal.effects) if (effect.kind === "transitionScene") reachable.add(effect.sceneId);

  for (const effect of proposal.effects) {
    switch (effect.kind) {
      case "transitionScene": {
        const scene = bible.scenes.find((candidate) => candidate.id === effect.sceneId);
        if (scene === undefined) problems.push(`Unknown scene "${effect.sceneId}".`);
        else if (scene.id === state.sceneId) problems.push(`The party is already in ${scene.id}; drop the transition.`);
        else effects.push({ effect: { kind: "transitionScene", sceneId: scene.id }, when: effect.when });
        break;
      }
      case "startEncounter": {
        const encounter = findEncounter(bible, effect.encounterId);
        if (encounter === undefined) problems.push(`Unknown encounter "${effect.encounterId}".`);
        else if (state.encounterHistory.includes(encounter.id)) problems.push(`${encounter.id} has already been fought.`);
        else if (!reachable.has(encounter.sceneId)) problems.push(`${encounter.id} belongs to ${encounter.sceneId}, where the party is not.`);
        else effects.push({ effect: { kind: "startEncounter", encounter: encounterSpec(encounter) }, when: effect.when });
        break;
      }
      case "advanceClock": {
        const clock = findClock(bible, effect.clockId);
        if (clock === undefined) problems.push(`Unknown clock "${effect.clockId}".`);
        else if (!reachable.has(clock.sceneId)) problems.push(`${clock.id} belongs to ${clock.sceneId}, where the party is not.`);
        else if (!Number.isInteger(effect.by) || effect.by < 1 || effect.by > 3) problems.push(`${clock.id} may advance by 1 to 3 segments.`);
        else {
          const fight = findEncounter(bible, clock.onFull);
          const onFull = fight === undefined || state.encounterHistory.includes(fight.id) ? null : encounterSpec(fight);
          effects.push({ effect: { kind: "advanceClock", clockId: clock.id, segments: clock.segments, by: effect.by, onFull }, when: effect.when });
        }
        break;
      }
      case "revealClue": {
        const clue = findClue(bible, effect.clueId);
        if (clue === undefined) problems.push(`Unknown clue "${effect.clueId}".`);
        else if (state.clues.some((known) => known.id === clue.id)) problems.push(`${clue.id} was already revealed.`);
        else if (!reachable.has(clue.sceneId)) problems.push(`${clue.id} belongs to ${clue.sceneId}, where the party is not.`);
        else effects.push({ effect: { kind: "revealClue", clueId: clue.id, text: clue.publicText }, when: effect.when });
        break;
      }
      default:
        problems.push("Unknown story effect.");
    }
  }
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "resolved", proposal: { roundNumber: proposal.roundNumber, actions: proposal.actions, effects } };
}
