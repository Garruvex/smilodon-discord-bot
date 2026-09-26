import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import {
  RevisionConflictError,
  type CampaignKey,
  type CampaignTransaction,
  type CampaignUnitOfWork,
  type CommandOutcome,
  type EventEnvelope,
  type OutboxItem,
  type OutboxRequest,
  type SavedRoll,
  type StoredCampaign,
  type TimerRecord,
} from "../../../application/campaign/ports/campaign-store.js";
import type { CampaignLifecycle, CampaignRecord, GuildCampaignSettings, StoredRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { TimerSpec } from "../../../domain/campaign/engine/engine-request.js";

interface CampaignData {
  records: Map<string, StoredRecord>;
  guildSettings: Map<string, GuildCampaignSettings>;
  campaigns: Map<string, StoredCampaign>;
  events: Map<string, EventEnvelope[]>;
  processed: Map<string, CommandOutcome>;
  outbox: Map<string, OutboxItem>;
  timers: Map<string, TimerRecord>;
  rolls: Map<string, SavedRoll>;
}

// The campaign store for the headless harness and application tests. Each
// transaction works on a copy and replaces the data only when it succeeds,
// so a failure part-way leaves nothing behind, as a database would.
export class InMemoryCampaignStore implements CampaignUnitOfWork {
  private data: CampaignData = {
    records: new Map(),
    guildSettings: new Map(),
    campaigns: new Map(),
    events: new Map(),
    processed: new Map(),
    outbox: new Map(),
    timers: new Map(),
    rolls: new Map(),
  };
  private readonly lock = new KeyedSerialQueue();

  public async transaction<T>(work: (tx: CampaignTransaction) => Promise<T>): Promise<T> {
    return this.lock.run("store", async () => {
      const draft = structuredClone(this.data);
      const result = await work(new InMemoryTransaction(draft));
      this.data = draft;
      return result;
    });
  }
}

class InMemoryTransaction implements CampaignTransaction {
  public constructor(private readonly data: CampaignData) {}

  public loadCampaign(key: CampaignKey): Promise<StoredCampaign | undefined> {
    return Promise.resolve(this.data.campaigns.get(campaignKey(key)));
  }

  public createCampaign(key: CampaignKey, campaign: StoredCampaign): Promise<void> {
    const id = campaignKey(key);
    if (this.data.campaigns.has(id)) return Promise.reject(new Error(`Campaign ${key.campaignId} already exists.`));
    this.data.campaigns.set(id, campaign);
    return Promise.resolve();
  }

  public saveCampaign(key: CampaignKey, state: CampaignState, expectedRevision: number): Promise<number> {
    const id = campaignKey(key);
    const stored = this.data.campaigns.get(id);
    if (stored === undefined) return Promise.reject(new Error(`Campaign ${key.campaignId} does not exist.`));
    if (stored.revision !== expectedRevision) {
      return Promise.reject(new RevisionConflictError(key, expectedRevision, stored.revision));
    }
    const revision = stored.revision + 1;
    this.data.campaigns.set(id, { ...stored, state, revision });
    return Promise.resolve(revision);
  }

  public appendEvents(key: CampaignKey, events: readonly Omit<EventEnvelope, "sequence">[]): Promise<void> {
    const id = campaignKey(key);
    const log = this.data.events.get(id) ?? [];
    for (const event of events) log.push({ ...event, sequence: log.length + 1 });
    this.data.events.set(id, log);
    return Promise.resolve();
  }

  public readEvents(key: CampaignKey): Promise<readonly EventEnvelope[]> {
    return Promise.resolve(this.data.events.get(campaignKey(key)) ?? []);
  }

  public findProcessedCommand(key: CampaignKey, commandId: string): Promise<CommandOutcome | undefined> {
    return Promise.resolve(this.data.processed.get(scoped(key, commandId)));
  }

  public recordProcessedCommand(key: CampaignKey, commandId: string, outcome: CommandOutcome): Promise<void> {
    this.data.processed.set(scoped(key, commandId), outcome);
    return Promise.resolve();
  }

  public enqueue(key: CampaignKey, id: string, request: OutboxRequest, now: number): Promise<void> {
    if (!this.data.outbox.has(id)) {
      this.data.outbox.set(id, { id, key, request, status: "pending", attempts: 0, createdAt: now, lastError: null });
    }
    return Promise.resolve();
  }

  public pendingOutbox(kind: OutboxRequest["kind"]): Promise<readonly OutboxItem[]> {
    return Promise.resolve(
      [...this.data.outbox.values()].filter((item) => item.status === "pending" && item.request.kind === kind),
    );
  }

  public completeOutbox(id: string): Promise<void> {
    const item = this.data.outbox.get(id);
    if (item !== undefined) this.data.outbox.set(id, { ...item, status: "done" });
    return Promise.resolve();
  }

  public failOutboxAttempt(id: string, error: string, maxAttempts: number): Promise<void> {
    const item = this.data.outbox.get(id);
    if (item !== undefined) {
      const attempts = item.attempts + 1;
      this.data.outbox.set(id, { ...item, attempts, lastError: error, status: attempts >= maxAttempts ? "failed" : "pending" });
    }
    return Promise.resolve();
  }

  public scheduleTimer(key: CampaignKey, timer: TimerSpec): Promise<void> {
    this.data.timers.set(scoped(key, timer.timerId), { key, timer, status: "pending" });
    return Promise.resolve();
  }

  public cancelTimer(key: CampaignKey, timerId: string): Promise<void> {
    const id = scoped(key, timerId);
    const record = this.data.timers.get(id);
    if (record?.status === "pending") this.data.timers.set(id, { ...record, status: "cancelled" });
    return Promise.resolve();
  }

  public dueTimers(now: number): Promise<readonly TimerRecord[]> {
    return Promise.resolve(
      [...this.data.timers.values()]
        .filter((record) => record.status === "pending" && record.timer.dueAt <= now)
        .sort((a, b) => a.timer.dueAt - b.timer.dueAt),
    );
  }

  public markTimerFired(key: CampaignKey, timerId: string): Promise<void> {
    const id = scoped(key, timerId);
    const record = this.data.timers.get(id);
    if (record?.status === "pending") this.data.timers.set(id, { ...record, status: "fired" });
    return Promise.resolve();
  }

  public createRecord(record: CampaignRecord): Promise<void> {
    const id = campaignKey(record.key);
    if (this.data.records.has(id)) return Promise.reject(new Error(`Campaign ${record.key.campaignId} already exists.`));
    this.data.records.set(id, { record, revision: 0 });
    return Promise.resolve();
  }

  public loadRecord(key: CampaignKey): Promise<StoredRecord | undefined> {
    return Promise.resolve(this.data.records.get(campaignKey(key)));
  }

  public saveRecord(record: CampaignRecord, expectedRevision: number): Promise<number> {
    const id = campaignKey(record.key);
    const stored = this.data.records.get(id);
    if (stored === undefined) return Promise.reject(new Error(`Campaign ${record.key.campaignId} does not exist.`));
    if (stored.revision !== expectedRevision) return Promise.reject(new RevisionConflictError(record.key, expectedRevision, stored.revision));
    const revision = stored.revision + 1;
    this.data.records.set(id, { record, revision });
    return Promise.resolve(revision);
  }

  public listRecords(guildId: string, lifecycles?: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]> {
    return Promise.resolve(
      [...this.data.records.values()].filter(
        (stored) => stored.record.key.guildId === guildId && (lifecycles === undefined || lifecycles.includes(stored.record.lifecycle)),
      ),
    );
  }

  public listRecordsByLifecycle(lifecycles: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]> {
    return Promise.resolve([...this.data.records.values()].filter((stored) => lifecycles.includes(stored.record.lifecycle)));
  }

  public loadGuildSettings(guildId: string): Promise<GuildCampaignSettings | undefined> {
    return Promise.resolve(this.data.guildSettings.get(guildId));
  }

  public saveGuildSettings(settings: GuildCampaignSettings): Promise<void> {
    this.data.guildSettings.set(settings.guildId, settings);
    return Promise.resolve();
  }

  public findRoll(key: CampaignKey, rollId: string): Promise<SavedRoll | undefined> {
    return Promise.resolve(this.data.rolls.get(scoped(key, rollId)));
  }

  public saveRoll(roll: SavedRoll): Promise<SavedRoll> {
    const id = scoped(roll.key, roll.rollId);
    const existing = this.data.rolls.get(id);
    if (existing !== undefined) return Promise.resolve(existing);
    this.data.rolls.set(id, roll);
    return Promise.resolve(roll);
  }
}

function campaignKey(key: CampaignKey): string {
  return `${key.guildId}\u0000${key.campaignId}`;
}

function scoped(key: CampaignKey, id: string): string {
  return `${campaignKey(key)}\u0000${id}`;
}
