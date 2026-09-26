import type { CheckTest } from "../character/character-sheet.js";
import type { CharacterId, CheckId, RollId, UserId } from "../core/ids.js";
import type { D20TestRoll } from "../dice/d20-test.js";
import type { LedgerVisibility } from "../ledger/ledger.js";
import type { DcTier, RollModeReason } from "../rules/difficulty.js";

// Who issued a command. Users are checked against saved campaign state
// (membership, ownership, organizer); the system covers timers and workers.
export type Actor = { readonly kind: "user"; readonly userId: UserId } | { readonly kind: "system" };

// Closed union: decide() handles every kind with an exhaustive switch.
export type CampaignCommand =
  // Opens the next round: by the system after narration, or by a present
  // member after a quiet round.
  | { readonly kind: "openRound" }
  | { readonly kind: "submitAction"; readonly characterId: CharacterId; readonly text: string }
  | { readonly kind: "pass"; readonly characterId: CharacterId }
  | { readonly kind: "closeRound" }
  | { readonly kind: "roundTimerExpired"; readonly roundNumber: number }
  | { readonly kind: "applyRoundPlan"; readonly proposal: RoundPlanProposal }
  | { readonly kind: "requestRoll"; readonly checkId: CheckId }
  | { readonly kind: "rollTimerExpired"; readonly checkId: CheckId }
  | { readonly kind: "recordRoll"; readonly rollId: RollId; readonly roll: D20TestRoll }
  | { readonly kind: "markAway"; readonly userId: UserId }
  | { readonly kind: "markReturned"; readonly userId: UserId }
  // Resumes a campaign that was waiting for players.
  | { readonly kind: "continue" }
  // The Planner could not produce a valid proposal after its retry.
  | { readonly kind: "reportPlannerFailure"; readonly roundNumber: number; readonly problems: readonly string[] }
  // The organizer asks the Planner to try the held round again.
  | { readonly kind: "retryPlan" }
  | { readonly kind: "recordNarration"; readonly roundNumber: number; readonly text: string }
  | RecordLedgerFactCommand;

export interface RecordLedgerFactCommand {
  readonly kind: "recordLedgerFact";
  readonly entityId: string;
  readonly canonicalName: string;
  readonly fact: string;
  readonly visibility: LedgerVisibility;
}

export type CampaignCommandKind = CampaignCommand["kind"];

// The Planner's structured proposal for a closed round, validated by the
// engine before anything applies. Clarification, conflicts, dependencies,
// and story effects join this shape with the DM pipeline.
export interface RoundPlanProposal {
  readonly roundNumber: number;
  readonly actions: readonly PlannedAction[];
}

export interface PlannedAction {
  readonly characterId: CharacterId;
  readonly resolution: PlannedResolution;
}

export type PlannedResolution =
  | { readonly kind: "automatic"; readonly reason: string }
  | { readonly kind: "impossible"; readonly reason: string }
  | {
      readonly kind: "check";
      readonly test: CheckTest;
      readonly dcTier: DcTier;
      readonly rollModeReasons: readonly RollModeReason[];
    };
