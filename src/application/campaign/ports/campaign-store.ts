import type { CampaignLifecycle, CampaignRecord, GuildCampaignSettings, StoredRecord } from "./campaign-record.js";
import type { LibraryCharacter, LibrarySnapshot } from "../library/library-types.js";
import type { StoredAdventure } from "../adventures/stored-adventure.js";
import type { Actor, CampaignCommandKind } from "../../../domain/campaign/commands/campaign-command.js";
import type { CampaignId, Instant, RollId, TimerId } from "../../../domain/campaign/core/ids.js";
import type { RollResult } from "../../../domain/campaign/dice/roll-spec.js";
import type { EngineRequest, TimerSpec } from "../../../domain/campaign/engine/engine-request.js";
import type { Rejection } from "../../../domain/campaign/engine/rejection.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// Every campaign lookup takes both IDs, so no code path can read another
// guild's campaign (code structure §11).
export interface CampaignKey {
  readonly guildId: string;
  readonly campaignId: CampaignId;
}

export interface RulesetPin {
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  // Expanded house-rule values saved at setup.
  readonly houseRules: Readonly<Record<string, string>>;
}

export interface AdventurePin {
  readonly adventureId: string;
  readonly version: string;
}

export interface StoredCampaign {
  readonly state: CampaignState;
  // The compare-and-set point: every accepted command moves it by one.
  readonly revision: number;
  readonly ruleset: RulesetPin;
  readonly adventure: AdventurePin;
}

export interface EventEnvelope {
  readonly campaignId: CampaignId;
  readonly sequence: number;
  // The command that caused the event.
  readonly causationId: string;
  readonly commandKind: CampaignCommandKind;
  readonly actor: Actor;
  // "<ruleset id>@<version>" in force when the event was decided.
  readonly rulesRevision: string;
  readonly recordedAt: Instant;
  readonly event: CampaignEvent;
}

export type CommandOutcome =
  | { readonly kind: "accepted"; readonly revision: number; readonly eventCount: number }
  | { readonly kind: "rejected"; readonly rejection: Rejection }
  | { readonly kind: "notFound" };

// Work for the workers, written in the same transaction as the events.
// Timers live in their own table (TimerRecord) instead.
export type OutboxRequest = Exclude<EngineRequest, { kind: "startTimer" } | { kind: "cancelTimer" }>;

export interface OutboxItem {
  readonly id: string;
  readonly key: CampaignKey;
  readonly request: OutboxRequest;
  readonly status: "pending" | "done" | "failed";
  readonly attempts: number;
  readonly createdAt: Instant;
  readonly lastError: string | null;
  // A failed attempt is not retried before this time (0: no wait).
  readonly notBefore: Instant;
}

export interface TimerRecord {
  readonly key: CampaignKey;
  readonly timer: TimerSpec;
  readonly status: "pending" | "fired" | "cancelled";
}

export interface SavedRoll {
  readonly key: CampaignKey;
  readonly rollId: RollId;
  readonly result: RollResult;
  readonly rolledAt: Instant;
}

// One transaction. Every write is all-or-nothing with the others made
// through the same transaction.
export interface CampaignTransaction {
  loadCampaign(key: CampaignKey): Promise<StoredCampaign | undefined>;
  createCampaign(key: CampaignKey, campaign: StoredCampaign): Promise<void>;
  // Compare-and-set on the revision. Throws RevisionConflictError when the
  // stored revision is not `expectedRevision`.
  saveCampaign(key: CampaignKey, state: CampaignState, expectedRevision: number): Promise<number>;

  appendEvents(key: CampaignKey, events: readonly Omit<EventEnvelope, "sequence">[]): Promise<void>;
  readEvents(key: CampaignKey): Promise<readonly EventEnvelope[]>;

  findProcessedCommand(key: CampaignKey, commandId: string): Promise<CommandOutcome | undefined>;
  recordProcessedCommand(key: CampaignKey, commandId: string, outcome: CommandOutcome): Promise<void>;

  enqueue(key: CampaignKey, id: string, request: OutboxRequest, now: Instant): Promise<void>;
  pendingOutbox(kind: OutboxRequest["kind"]): Promise<readonly OutboxItem[]>;
  completeOutbox(id: string): Promise<void>;
  // `retryAt` holds the next attempt back (backoff); without it the next pass retries.
  failOutboxAttempt(id: string, error: string, maxAttempts: number, retryAt?: Instant): Promise<void>;
  // Puts the campaign's given-up work back in the queue with a fresh count
  // (Repair). Returns how many items were requeued.
  requeueFailedOutbox(key: CampaignKey): Promise<number>;

  // Scheduling a timer ID that already exists replaces it (a resumed
  // campaign reschedules its roll timers).
  scheduleTimer(key: CampaignKey, timer: TimerSpec): Promise<void>;
  cancelTimer(key: CampaignKey, timerId: TimerId): Promise<void>;
  dueTimers(now: Instant): Promise<readonly TimerRecord[]>;
  markTimerFired(key: CampaignKey, timerId: TimerId): Promise<void>;

  // The campaign record: lobby, settings, and Discord places. It exists from
  // creation; the engine campaign above exists from the start.
  createRecord(record: CampaignRecord): Promise<void>;
  loadRecord(key: CampaignKey): Promise<StoredRecord | undefined>;
  // Compare-and-set on the record's own revision; returns the new one.
  saveRecord(record: CampaignRecord, expectedRevision: number): Promise<number>;
  listRecords(guildId: string, lifecycles?: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]>;
  // Across every server: what the startup recovery walks.
  listRecordsByLifecycle(lifecycles: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]>;

  loadGuildSettings(guildId: string): Promise<GuildCampaignSettings | undefined>;
  // Every server that has been set up: what the startup redraw walks.
  listGuildSettings(): Promise<readonly GuildCampaignSettings[]>;
  // Replaces the server's settings (one row per server; last write wins).
  saveGuildSettings(settings: GuildCampaignSettings): Promise<void>;

  // The character library. Snapshots are written once and never changed.
  saveLibraryCharacter(character: LibraryCharacter): Promise<void>;
  loadLibraryCharacter(id: string): Promise<LibraryCharacter | undefined>;
  listLibraryCharacters(ownerUserId: string): Promise<readonly LibraryCharacter[]>;
  // Removes the character and every snapshot of it.
  deleteLibraryCharacter(id: string): Promise<void>;
  saveLibrarySnapshot(snapshot: LibrarySnapshot): Promise<void>;
  loadLibrarySnapshot(id: string): Promise<LibrarySnapshot | undefined>;
  // In revision order.
  listLibrarySnapshots(characterId: string): Promise<readonly LibrarySnapshot[]>;
  findLibrarySnapshotBySourceKey(characterId: string, sourceKey: string): Promise<LibrarySnapshot | undefined>;

  // Uploaded and authored adventures, from pending review to approved.
  saveAdventure(adventure: StoredAdventure): Promise<void>;
  loadAdventure(key: string): Promise<StoredAdventure | undefined>;
  // A server's own, oldest first, optionally of one status.
  listAdventures(guildId: string, status?: StoredAdventure["status"]): Promise<readonly StoredAdventure[]>;
  // Every server's approved ones: what startup loads into the library.
  listAdventuresByStatus(status: StoredAdventure["status"]): Promise<readonly StoredAdventure[]>;

  findRoll(key: CampaignKey, rollId: RollId): Promise<SavedRoll | undefined>;
  // Written once; saving an existing roll ID keeps the first result.
  saveRoll(roll: SavedRoll): Promise<SavedRoll>;
}

export interface CampaignUnitOfWork {
  transaction<T>(work: (tx: CampaignTransaction) => Promise<T>): Promise<T>;
}

export class RevisionConflictError extends Error {
  public constructor(
    public readonly key: CampaignKey,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Campaign ${key.campaignId} is at revision ${actual}, expected ${expected}.`);
    this.name = "RevisionConflictError";
  }
}
