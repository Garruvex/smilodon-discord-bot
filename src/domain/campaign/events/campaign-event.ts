import type { CharacterId, CheckId, Instant, RollId, UserId } from "../core/ids.js";
import type { CombatEvent } from "../combat/combat-events.js";
import type { HeroStatus } from "../combat/combatant-profile.js";
import type { LedgerVisibility } from "../ledger/ledger.js";
import type { SceneId } from "../adventure/adventure-bible.js";
import type { EncounterSpec, PlannedEffect } from "../commands/campaign-command.js";
import type { CharacterSheet } from "../character/character-sheet.js";
import type { ContentId } from "../rules/content-id.js";
import type { CheckResult, CheckState, ItemOffer, Resolution } from "../state/campaign-state.js";

// The version of the event shapes below. It goes up whenever a change to an
// event could not be read by code written for the old shape, and every recorded
// envelope carries the version it was written with, so old history can be
// upcast on read if it ever has to be replayed (docs/dnd-engine-architecture.md §7).
//   1  Everything up to milestone 6.
//   2  Conditions and lasting effects became one effect record: conditionAdded and
//      effectAdded were replaced by effectApplied.
export const eventSchemaVersion = 2;

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
  | { readonly kind: "proxyGranted"; readonly ownerUserId: string; readonly proxyUserId: string }
  | { readonly kind: "proxyRevoked"; readonly ownerUserId: string }
  | { readonly kind: "summaryRecorded"; readonly throughRound: number; readonly visibility: "public" | "private"; readonly text: string }
  | { readonly kind: "adventureBegan" }
  | { readonly kind: "openingRecorded"; readonly text: string }
  | { readonly kind: "memberReadied"; readonly userId: UserId }
  | { readonly kind: "tableReady" }
  | {
      readonly kind: "ledgerFactRecorded";
      readonly entityId: string;
      readonly canonicalName: string;
      readonly fact: string;
      readonly visibility: LedgerVisibility;
    }
  // Pending checks get fresh roll deadlines; timers were cancelled while waiting.
  | {
      readonly kind: "resumed";
      readonly checkDeadlines: Readonly<Record<CheckId, Instant | null>>;
      // Fresh windows for the round and the current player's turn, when they had one.
      readonly roundClosesAt?: Instant;
      readonly turnEndsAt?: Instant;
    }
  | { readonly kind: "campaignPaused"; readonly reason: "organizer" | "recovery" | "safety" }
  | { readonly kind: "heroSpoke"; readonly characterId: CharacterId; readonly roundNumber: number; readonly text: string }
  | { readonly kind: "restTaken"; readonly rest: "short" | "long"; readonly heroStatus: Readonly<Record<CharacterId, HeroStatus>> }
  | { readonly kind: "itemOffered"; readonly offer: ItemOffer }
  // The offer was accepted: the items change hands.
  | { readonly kind: "offerAccepted"; readonly offerId: string }
  | { readonly kind: "offerClosed"; readonly offerId: string; readonly reason: OfferClosedReason }
  | { readonly kind: "itemStashed"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  | { readonly kind: "itemTaken"; readonly characterId: CharacterId; readonly itemId: ContentId<"item"> }
  // A hero's worn armor and shield changed; `worn` is the whole list now.
  | { readonly kind: "wornChanged"; readonly characterId: CharacterId; readonly worn: readonly ContentId<"item">[] }
  // A victory's spoils reach the party stash, and the gold the purse or, when
  // `split` is given, the heroes' own coins by that amount each.
  | {
      readonly kind: "lootFound";
      readonly encounterId: string;
      readonly items: readonly ContentId<"item">[];
      readonly gold: number;
      readonly split?: Readonly<Record<CharacterId, number>>;
    }
  // The potion is drunk (and gone); healed is what it actually restored.
  | { readonly kind: "itemUsed"; readonly characterId: CharacterId; readonly itemId: ContentId<"item">; readonly healed: number }
  // The player has this hero from now on (a new player, or a replacement).
  | { readonly kind: "heroJoined"; readonly sheet: CharacterSheet }
  // The lost fight is set aside and the party is back as it stood at its start.
  | { readonly kind: "encounterRetried"; readonly encounterId: string }
  | CombatEvent;

export type OfferClosedReason = "declined" | "cancelled" | "unavailable";

export type CampaignEventKind = CampaignEvent["kind"];

// Only a timer expiry counts toward automatic away; an organizer closing
// the window early does not.
export type RoundCloseReason = "allResponded" | "timer" | "organizer";

export type AwayReason = "self" | "organizer" | "missedTimers";
