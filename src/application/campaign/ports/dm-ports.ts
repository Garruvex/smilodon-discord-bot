import type { AdventureBible, CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { EffectCondition, PlannedAction } from "../../../domain/campaign/commands/campaign-command.js";
import type { EncounterOutcome } from "../../../domain/campaign/combat/combat-state.js";
import type { CombatBeat } from "../dm/combat-records.js";
import type { RollMoment } from "../../../domain/campaign/dice/roll-moments.js";

// One layer of DM context (plan §6), in cache-friendly order A to F.
export interface ContextSection {
  readonly layer: "A" | "B" | "C" | "D" | "E" | "F";
  readonly title: string;
  readonly text: string;
}

export interface DmContext {
  readonly sections: readonly ContextSection[];
  readonly estimatedTokens: number;
  // Oldest transcript rounds left out to fit the budget, pending summaries.
  readonly omittedRounds: number;
}

export interface PlannerRequest {
  readonly context: DmContext;
  readonly roundNumber: number;
  readonly actions: readonly { readonly characterId: string; readonly heroName: string; readonly text: string }[];
  // Everything a proposal may reference; the adapter builds its JSON schema from this.
  readonly vocabulary: {
    readonly abilities: readonly string[];
    readonly skills: readonly string[];
    readonly dcTiers: readonly string[];
    readonly rollModeReasons: readonly string[];
  };
  // Where the story may go: story effects may name only these IDs.
  readonly story: {
    readonly sceneId: string | null;
    readonly sceneIds: readonly string[];
    // Encounters not yet fought, with the scene each belongs to.
    readonly encounters: readonly { readonly id: string; readonly sceneId: string }[];
  };
  // Validation problems from the previous attempt, for the one retry.
  readonly previousProblems: readonly string[];
}

// The Planner's proposal as the model states it: story effects name
// authored IDs, which the DM job resolves (and checks) before the engine
// validates the whole proposal.
export interface PlannerProposal {
  readonly roundNumber: number;
  readonly actions: readonly PlannedAction[];
  readonly effects: readonly PlannerEffect[];
}

export type PlannerEffect =
  | { readonly kind: "transitionScene"; readonly sceneId: string; readonly when: EffectCondition }
  | { readonly kind: "startEncounter"; readonly encounterId: string; readonly when: EffectCondition };

// Narrow, per-purpose model calls (plan §6, DM call pipeline). Adapters
// parse the provider's structured output; the engine validates it.
export interface CampaignPlanner {
  plan(request: PlannerRequest): Promise<PlannerProposal>;
}

export interface NarratedOutcome {
  readonly heroName: string;
  readonly action: string;
  readonly result:
    | { readonly kind: "automatic" }
    | { readonly kind: "impossible" }
    | {
        readonly kind: "check";
        readonly check: string;
        readonly total: number;
        readonly dc: number;
        readonly success: boolean;
        readonly headline: RollMoment | null;
      };
}

export interface NarratorRequest {
  // Public-only: never contains DM notes, secrets, or Planner reasoning.
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly roundNumber: number;
  readonly outcomes: readonly NarratedOutcome[];
  // Heroes who did not act this round, to address by name.
  readonly spotlight: readonly string[];
  // A fight breaks out after this round: its public description, to lead into.
  readonly threat: string | null;
}

// One combat round's flourish, or (final) the fight's closing narration
// (plan §6, Combat presentation). Beats are committed, public results.
export interface CombatNarratorRequest {
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly encounterId: string;
  readonly round: number;
  readonly final: boolean;
  readonly beats: readonly CombatBeat[];
  // Set on the closing narration.
  readonly outcome: EncounterOutcome | null;
}

export interface CampaignNarrator {
  narrate(request: NarratorRequest): Promise<{ readonly text: string }>;
  narrateCombat(request: CombatNarratorRequest): Promise<{ readonly text: string }>;
}

export interface AdventureCatalog {
  find(adventureId: string, version: string): AdventureBible | undefined;
}
