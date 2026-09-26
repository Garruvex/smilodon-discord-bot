import type { AdventureBible, CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { RoundPlanProposal } from "../../../domain/campaign/commands/campaign-command.js";
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
  // Validation problems from the previous attempt, for the one retry.
  readonly previousProblems: readonly string[];
}

// Narrow, per-purpose model calls (plan §6, DM call pipeline). Adapters
// parse the provider's structured output; the engine validates it.
export interface CampaignPlanner {
  plan(request: PlannerRequest): Promise<RoundPlanProposal>;
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
}

export interface CampaignNarrator {
  narrate(request: NarratorRequest): Promise<{ readonly text: string }>;
}

export interface AdventureCatalog {
  find(adventureId: string, version: string): AdventureBible | undefined;
}
