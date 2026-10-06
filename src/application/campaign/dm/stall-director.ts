import type { AdventureBible, BibleClue, BibleInteraction } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { PlannerEffect, PlannerProposal } from "../ports/dm-ports.js";
import { availableInteractions, requirementMet } from "./interactions.js";

// The stall director: a table that stops making progress is helped along, step by step, so the story always has a way forward. It is plain
// rules over the adventure's own data (no model, nothing invented):
//   1  a hint        the narrator ends on a concrete, in-fiction nudge toward something the scene has ready;
//   2  a free clue   the scene's next unrevealed clue is simply learned;
//   3  the next step an interaction the adventure marked `fallback: true` happens without a roll or a fee. Only the adventure may authorize
//                    this, so a table is never moved against what the story established.
// Progress is the story moving: a clue, a scene change, a fight, a clock, a keepsake, loot, or a flag an interaction set.

export interface StallConfig {
  // Rounds with no progress before each step.
  readonly hint: number;
  readonly clue: number;
  readonly step: number;
}

export const defaultStall: StallConfig = { hint: 3, clue: 6, step: 9 };

export type StallLevel = 0 | 1 | 2 | 3;

const movedTheStory = (event: CampaignEvent): boolean => {
  switch (event.kind) {
    case "clueRevealed":
    case "sceneTransitioned":
    case "encounterQueued":
    case "clockAdvanced":
    case "keepsakeGained":
    case "lootFound":
      return true;
    case "flagSet":
      // The engine's own bookkeeping for tries is not the story moving; a success (done:) and an authored flag are.
      return !event.flag.startsWith("tried:");
    default:
      return false;
  }
};

// Rounds that finished since the story last moved.
export function stalledRounds(events: readonly CampaignEvent[]): number {
  let rounds = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (movedTheStory(event)) return rounds;
    if (event.kind === "roundResolved") rounds += 1;
  }
  return rounds;
}

export function stallLevel(stalled: number, config: StallConfig = defaultStall): StallLevel {
  if (stalled >= config.step) return 3;
  if (stalled >= config.clue) return 2;
  if (stalled >= config.hint) return 1;
  return 0;
}

// Whether doing it would move the story: it sets a flag, reveals a clue, moves the party, or starts a fight.
const advances = (interaction: BibleInteraction): boolean =>
  [...interaction.onSuccess, ...interaction.tiers.flatMap((tier) => tier.effects)].some((effect) => ["set", "reveal", "goto", "encounter"].includes(effect.kind));

// The lead the narrator points at: the first open interaction that would move the story, in the order the adventure lists them.
export function openLead(bible: AdventureBible, state: CampaignState): BibleInteraction | undefined {
  return availableInteractions(bible, state).find(advances);
}

// The label without the skill the author put in brackets, so a nudge never names a check.
export const plainLabel = (label: string): string => label.replace(/\s*[（(][^）)]*[）)]\s*$/u, "").trim();

// The scene's next clue the party does not have, in the order the adventure lists them.
export function nextClue(bible: AdventureBible, state: CampaignState): BibleClue | undefined {
  return bible.clues.find((clue) => clue.sceneId === state.sceneId && !state.clues.some((known) => known.id === clue.id));
}

// Applies the director's step to a planned round: the second step adds a free clue; the third takes the adventure's fallback step by planning
// the first hero's action as that interaction with no roll and no fee. Returns the proposal and the bible to resolve it against.
export function directPlan(proposal: PlannerProposal, bible: AdventureBible, state: CampaignState, level: StallLevel): { readonly proposal: PlannerProposal; readonly bible: AdventureBible } {
  if (level < 2) return { proposal, bible };
  let next = proposal;
  let story = bible;
  const clue = nextClue(bible, state);
  if (clue !== undefined) next = { ...next, effects: [...next.effects, { kind: "revealClue", clueId: clue.id, when: { kind: "always" } }] };
  if (level >= 3) {
    const step = availableInteractions(bible, state).find((interaction) => interaction.fallback === true);
    const hero = next.actions.find((action) => action.interactionId == null);
    if (step !== undefined && hero !== undefined) {
      next = { ...next, actions: next.actions.map((action) => (action === hero ? { ...action, resolution: { kind: "automatic", reason: step.label }, interactionId: step.id } : action)) };
      // With no roll and no fee, so the step happens however the dice would have fallen.
      story = { ...bible, interactions: (bible.interactions ?? []).map((interaction) => (interaction.id === step.id ? { ...interaction, check: null, pay: 0 } : interaction)) };
    }
  }
  return { proposal: next, bible: story };
}

// Rounds the party has spent in the scene they are in: the finished rounds since they arrived (or since the story began).
export function roundsInScene(events: readonly CampaignEvent[]): number {
  let rounds = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "sceneTransitioned") return rounds;
    if (event?.kind === "roundResolved") rounds += 1;
  }
  return rounds;
}

// A fight the adventure scheduled (see BibleEncounter.schedule) that is due now: the party is in its scene, its requirement holds, it is the right
// time of day, and enough rounds have passed. At most one, and none while a fight is under way or queued.
export function scheduledEffects(bible: AdventureBible, state: CampaignState, events: readonly CampaignEvent[]): readonly PlannerEffect[] {
  if (state.pendingEncounter !== null || (state.encounter !== null && state.encounter.status !== "ended")) return [];
  const rounds = roundsInScene(events);
  const due = bible.encounters.find((encounter) =>
    encounter.schedule !== undefined &&
    encounter.sceneId === state.sceneId &&
    !state.encounterHistory.includes(encounter.id) &&
    requirementMet(encounter.schedule.requires, state) &&
    (encounter.schedule.time === undefined || state.world?.time === encounter.schedule.time) &&
    rounds >= (encounter.schedule.afterRounds ?? 0));
  return due === undefined ? [] : [{ kind: "startEncounter", encounterId: due.id, when: { kind: "always" } }];
}
