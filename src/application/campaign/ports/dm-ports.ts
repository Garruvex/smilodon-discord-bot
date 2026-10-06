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
    // A move the table has not yet agreed to: the party is already heading there.
    readonly pendingMoveTo?: string;
    readonly sceneIds: readonly string[];
    // Encounters not yet fought, with the scene each belongs to.
    readonly encounters: readonly { readonly id: string; readonly sceneId: string }[];
    // Clocks with their progress, and clues not yet revealed.
    readonly clocks: readonly { readonly id: string; readonly sceneId: string; readonly filled: number; readonly segments: number }[];
    readonly clues: readonly { readonly id: string; readonly sceneId: string }[];
    // The authored interactions the party can attempt right now (in this scene, requirements met, attempts left).
    readonly interactions?: readonly { readonly id: string; readonly sceneId: string; readonly label: string }[];
  };
  // Validation problems from the previous attempt, for the one retry.
  readonly previousProblems: readonly string[];
}

// The Planner's proposal as the model states it: story effects name
// authored IDs, which the DM job resolves (and checks) before the engine
// validates the whole proposal.
// A planned action, and the authored interaction it is an attempt at (the DM job replaces the check with the interaction's own).
export type PlannerAction = PlannedAction & { readonly interactionId?: string | null };

export interface PlannerProposal {
  readonly roundNumber: number;
  readonly actions: readonly PlannerAction[];
  readonly effects: readonly PlannerEffect[];
  // Authored interactions that happen as the story's own doing (the stall director's fallback step): no hero, no roll, no fee.
  readonly worldSteps?: readonly string[];
}

export type PlannerEffect =
  // movers: the heroes whose actions head there this round (absent: not stated, so the move is not judged by who wants it).
  | { readonly kind: "transitionScene"; readonly sceneId: string; readonly when: EffectCondition; readonly movers?: readonly string[] }
  | { readonly kind: "startEncounter"; readonly encounterId: string; readonly when: EffectCondition }
  | { readonly kind: "advanceClock"; readonly clockId: string; readonly by: number; readonly when: EffectCondition }
  | { readonly kind: "revealClue"; readonly clueId: string; readonly when: EffectCondition };

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
  // Set for the adventure's opening, told before the first round (round 0, no
  // outcomes): the heroes to introduce as the party.
  readonly opening?: { readonly heroes: readonly { readonly name: string; readonly className: string | null }[] };
  // Facts the last attempt invented (the adventure did not establish them): tell it again without them.
  readonly avoid?: readonly string[];
  // The table has gone several rounds without the story moving: something the scene has ready, in the players' words, for the narration to point at.
  readonly nudge?: string;
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
  // Facts the last attempt invented (the adventure did not establish them): tell it again without them.
  readonly avoid?: readonly string[];
}

// A settled trade's NPC reaction (plan §6, Narrator): the price, the check
// (if any), and who won it are already decided by the engine; this call only
// voices the NPC in character. `haggle` is null for an unhaggled buy/sell.
export interface TradeNarratorRequest {
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly npc: { readonly id: string; readonly name: string; readonly voice: string };
  readonly heroName: string;
  readonly itemName: string;
  readonly direction: "buy" | "sell";
  readonly completed: boolean;
  readonly listedPrice: number;
  readonly finalPrice: number;
  readonly haggle: { readonly skill: string; readonly total: number; readonly dc: number; readonly success: boolean; readonly headline: RollMoment | null } | null;
  // Facts the last attempt invented (the adventure did not establish them): tell it again without them.
  readonly avoid?: readonly string[];
}

// A settled conversation with an NPC (engine/dialogue.ts): a plain question
// is always answered, grounded only in what the NPC is authored to say in
// public; a press only reveals the secret when `secretRevealed` is true,
// already decided by a real check the engine ran — `npc.secret` carries the
// actual text only then, so the model can never leak it by accident. This
// call only voices the NPC; it never decides what they give up.
export interface DialogueNarratorRequest {
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly npc: { readonly id: string; readonly name: string; readonly voice: string; readonly publicDescription: string; readonly secret: string | null };
  readonly heroName: string;
  readonly kind: "ask" | "press";
  readonly question: string | null;
  readonly press: { readonly skill: string; readonly total: number; readonly dc: number; readonly success: boolean; readonly headline: RollMoment | null } | null;
  readonly secretRevealed: boolean;
  // What the NPC tells in this reply (facts the adventure says this NPC shares, already decided): the narrator voices them, adding nothing.
  readonly tells?: readonly string[];
  // Facts the last attempt invented (the adventure did not establish them): say it again without them.
  readonly avoid?: readonly string[];
}

// A ritual (or cantrip) spell cast outside combat (engine/utility-magic.ts):
// that the hero knows it and may cast it free is already decided; this call
// only describes what it reveals or does, grounded in the same scene and
// ledger context every other narration gets — never a new mechanical fact
// (a magic item, a hidden passage) the adventure text above doesn't already give.
export interface UtilityCastNarratorRequest {
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly heroName: string;
  readonly spell: { readonly id: string; readonly name: string };
  // Facts the last attempt invented (the adventure did not establish them): tell it again without them.
  readonly avoid?: readonly string[];
}

// A settled travel or environmental hazard (engine/travel.ts): the save, its
// DC, and whether it cost a level of Exhaustion are already decided; this
// call only describes the toll the journey or terrain took.
export interface HazardNarratorRequest {
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly heroName: string;
  readonly ability: string;
  readonly dc: number;
  readonly total: number;
  readonly success: boolean;
  readonly headline: RollMoment | null;
  readonly exhaustionGained: number;
  // Facts the last attempt invented (the adventure did not establish them): tell it again without them.
  readonly avoid?: readonly string[];
}

export interface CampaignNarrator {
  narrate(request: NarratorRequest): Promise<{ readonly text: string; readonly note?: string }>;
  narrateCombat(request: CombatNarratorRequest): Promise<{ readonly text: string }>;
  narrateTrade(request: TradeNarratorRequest): Promise<{ readonly text: string }>;
  narrateDialogue(request: DialogueNarratorRequest): Promise<{ readonly text: string }>;
  narrateUtilityCast(request: UtilityCastNarratorRequest): Promise<{ readonly text: string }>;
  narrateHazard(request: HazardNarratorRequest): Promise<{ readonly text: string }>;
}

// The background call that condenses rounds already told (plan §6, Chronicler).
export interface ChronicleRequest {
  readonly audience: "public" | "private";
  readonly language: CampaignLanguage;
  // The rounds since the last summary, as this audience may read them.
  readonly transcript: string;
  readonly previousSummary: string | null;
  // Entities already in the ledger this audience may see: their IDs and locked names.
  readonly knownEntities: readonly { readonly entityId: string; readonly canonicalName: string }[];
  // Present while merging public notes from one scene; omitted for the private full-story memory.
  readonly scene?: { readonly id: string; readonly title: string };
}

export interface ChronicleResult {
  readonly summary: string;
  readonly facts: readonly { readonly entityId: string; readonly canonicalName: string; readonly fact: string }[];
}

export interface CampaignChronicler {
  chronicle(request: ChronicleRequest): Promise<ChronicleResult>;
}

export interface SceneNoteJudgeRequest {
  readonly language: CampaignLanguage;
  readonly scene: { readonly id: string; readonly title: string; readonly publicDescription: string; readonly details?: string; readonly dmNotes: string };
  readonly adventure: { readonly title: string; readonly premise: string; readonly dmOverview: string };
  readonly establishedPeople: readonly { readonly id: string; readonly name: string; readonly description: string; readonly secret?: string }[];
  readonly committedOutcomes: readonly string[];
  readonly notes: readonly { readonly noteIndex: number; readonly text: string }[];
}

export interface SceneNoteJudgment {
  readonly noteIndex: number;
  readonly decision: "keep" | "reword" | "drop";
  readonly text: string;
  readonly reason: string;
}

// Every kind of line that can state a fact to the table.
export type NarrationKind = "narration" | "opening" | "dialogue" | "combat" | "trade" | "spell" | "hazard";

// A line about to be shown, to be read against what the adventure established. Returns what it invented (an item, a price, a demand, a person): empty when nothing.
export interface NarrationAuditRequest {
  readonly context: DmContext;
  readonly language: CampaignLanguage;
  readonly kind: NarrationKind;
  readonly text: string;
  // What was committed in this moment (the outcomes, what the NPC was told to say), which the context above does not yet hold.
  readonly facts: readonly string[];
}

export interface CampaignNarrationAuditor {
  audit(request: NarrationAuditRequest): Promise<readonly string[]>;
}

export interface CampaignSceneNoteJudge {
  judge(request: SceneNoteJudgeRequest): Promise<readonly SceneNoteJudgment[]>;
}

export interface AdventureCatalog {
  // A campaign plays one language edition of an adventure.
  find(adventureId: string, version: string, language: AdventureBible["language"]): AdventureBible | undefined;
}
