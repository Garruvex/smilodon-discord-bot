import type { CheckTest } from "../character/character-sheet.js";
import type { CharacterId, CheckId, RollId, UserId } from "../core/ids.js";
import type { RollResult } from "../dice/roll-spec.js";
import type { LedgerVisibility } from "../ledger/ledger.js";
import type { ContentId } from "../rules/content-id.js";
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
  | { readonly kind: "recordRoll"; readonly rollId: RollId; readonly result: RollResult }
  | { readonly kind: "markAway"; readonly userId: UserId }
  | { readonly kind: "markReturned"; readonly userId: UserId }
  // Resumes a campaign that was waiting for players.
  | { readonly kind: "continue" }
  // The Planner could not produce a valid proposal after its retry.
  | { readonly kind: "reportPlannerFailure"; readonly roundNumber: number; readonly problems: readonly string[] }
  // The organizer asks the Planner to try the held round again.
  | { readonly kind: "retryPlan" }
  | { readonly kind: "recordNarration"; readonly roundNumber: number; readonly text: string }
  | RecordLedgerFactCommand
  | CombatCommand;

// Combat. Hero commands name the acting combatant (the hero's character ID)
// so a stale button for another turn is refused rather than misapplied.
export type CombatCommand =
  | { readonly kind: "startEncounter"; readonly spec: EncounterSpec }
  | { readonly kind: "combatMove"; readonly combatantId: string; readonly zoneId: string }
  | { readonly kind: "combatEngage"; readonly combatantId: string; readonly targetId: string }
  | { readonly kind: "combatWithdraw"; readonly combatantId: string }
  | { readonly kind: "combatAttack"; readonly combatantId: string; readonly targetId: string; readonly weapon: ContentId<"item"> }
  | { readonly kind: "combatDash"; readonly combatantId: string }
  | { readonly kind: "combatDodge"; readonly combatantId: string }
  | { readonly kind: "endTurn"; readonly combatantId: string }
  | { readonly kind: "turnTimerExpired"; readonly encounterId: string; readonly turnNumber: number };

export interface EncounterSpec {
  readonly id: string;
  readonly zones: readonly { readonly id: string; readonly name: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[];
  readonly partyZoneId: string;
  readonly monsters: readonly EncounterMonster[];
}

export interface EncounterMonster {
  readonly monsterId: ContentId<"monster">;
  readonly zoneId: string;
  // A named NPC this monster plays, e.g. npc:skarn.
  readonly npcId: string | null;
  readonly fleeBelowHpFraction: number | null;
}

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
