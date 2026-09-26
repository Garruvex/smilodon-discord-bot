import type { CharacterId, CheckId, Instant, RollId, UserId } from "../core/ids.js";
import type { CombatEvent } from "../combat/combat-events.js";
import type { HeroStatus } from "../combat/combatant-profile.js";
import type { LedgerVisibility } from "../ledger/ledger.js";
import type { SceneId } from "../adventure/adventure-bible.js";
import type { EncounterSpec, PlannedEffect } from "../commands/campaign-command.js";
import type { CheckResult, CheckState, Resolution } from "../state/campaign-state.js";

// Domain event payloads. The command bus wraps each in an envelope with
// campaign ID, sequence, causation, actor, and rules revision.
export type CampaignEvent =
  | {
      readonly kind: "roundOpened";
      readonly roundNumber: number;
      readonly participants: readonly CharacterId[];
      readonly closesAt: Instant | null;
    }
  | {
      readonly kind: "actionSubmitted";
      readonly roundNumber: number;
      readonly characterId: CharacterId;
      readonly text: string;
      readonly revision: number;
    }
  | { readonly kind: "passSubmitted"; readonly roundNumber: number; readonly characterId: CharacterId }
  | { readonly kind: "slotExcused"; readonly roundNumber: number; readonly characterId: CharacterId }
  | {
      readonly kind: "roundClosed";
      readonly roundNumber: number;
      readonly reason: RoundCloseReason;
      readonly missed: readonly CharacterId[];
    }
  | {
      readonly kind: "roundPlanApplied";
      readonly roundNumber: number;
      readonly resolutions: Readonly<Record<CharacterId, Resolution>>;
      readonly checks: readonly CheckState[];
      readonly effects: readonly PlannedEffect[];
    }
  | { readonly kind: "checkRollStarted"; readonly checkId: CheckId; readonly rollId: RollId; readonly timedOut: boolean }
  | { readonly kind: "checkResolved"; readonly checkId: CheckId; readonly result: CheckResult }
  | { readonly kind: "roundResolved"; readonly roundNumber: number; readonly quiet: boolean }
  // Story effects that fired when a round resolved.
  | { readonly kind: "sceneTransitioned"; readonly roundNumber: number; readonly sceneId: SceneId }
  | { readonly kind: "encounterQueued"; readonly roundNumber: number; readonly encounter: EncounterSpec }
  | { readonly kind: "clockAdvanced"; readonly roundNumber: number; readonly clockId: string; readonly segments: number; readonly filled: number }
  | { readonly kind: "clueRevealed"; readonly roundNumber: number; readonly clueId: string; readonly text: string }
  | { readonly kind: "memberMarkedAway"; readonly userId: UserId; readonly reason: AwayReason }
  | { readonly kind: "memberReturned"; readonly userId: UserId }
  | { readonly kind: "waitingForPlayers" }
  | { readonly kind: "plannerFailed"; readonly roundNumber: number; readonly problems: readonly string[] }
  | { readonly kind: "planRetryRequested"; readonly roundNumber: number }
  | { readonly kind: "narrationRecorded"; readonly roundNumber: number; readonly text: string }
  | {
      readonly kind: "ledgerFactRecorded";
      readonly entityId: string;
      readonly canonicalName: string;
      readonly fact: string;
      readonly visibility: LedgerVisibility;
    }
  // Pending checks get fresh roll deadlines; timers were cancelled while waiting.
  | { readonly kind: "resumed"; readonly checkDeadlines: Readonly<Record<CheckId, Instant | null>> }
  | { readonly kind: "restTaken"; readonly rest: "short" | "long"; readonly heroStatus: Readonly<Record<CharacterId, HeroStatus>> }
  | CombatEvent;

export type CampaignEventKind = CampaignEvent["kind"];

// Only a timer expiry counts toward automatic away; an organizer closing
// the window early does not.
export type RoundCloseReason = "allResponded" | "timer" | "organizer";

export type AwayReason = "self" | "organizer" | "missedTimers";
