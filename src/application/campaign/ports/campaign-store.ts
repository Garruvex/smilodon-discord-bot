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
  failOutboxAttempt(id: string, error: string, maxAttempts: number): Promise<void>;

  // Scheduling a timer ID that already exists replaces it (a resumed
  // campaign reschedules its roll timers).
  scheduleTimer(key: CampaignKey, timer: TimerSpec): Promise<void>;
  cancelTimer(key: CampaignKey, timerId: TimerId): Promise<void>;
  dueTimers(now: Instant): Promise<readonly TimerRecord[]>;
  markTimerFired(key: CampaignKey, timerId: TimerId): Promise<void>;

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
