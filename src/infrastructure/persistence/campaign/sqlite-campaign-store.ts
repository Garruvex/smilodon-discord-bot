import type { Database } from "better-sqlite3";

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
import type { TimerSpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// Bumped when a table changes shape. Milestone 0 keeps the campaign tables
// self-contained (JSON payloads for events, state, and requests); they move
// under the Drizzle migrations when the Discord milestone adds its own tables.
const schemaVersion = 2;

const schema = `
CREATE TABLE IF NOT EXISTS campaign_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
  guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL, ruleset TEXT NOT NULL, adventure TEXT NOT NULL,
  PRIMARY KEY (guild_id, campaign_id)
);
CREATE TABLE IF NOT EXISTS campaign_records (
  guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, revision INTEGER NOT NULL, lifecycle TEXT NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (guild_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS campaign_records_by_guild ON campaign_records (guild_id, lifecycle);
CREATE TABLE IF NOT EXISTS campaign_guild_settings (guild_id TEXT PRIMARY KEY, settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS campaign_events (
  guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, sequence INTEGER NOT NULL, envelope TEXT NOT NULL,
  PRIMARY KEY (guild_id, campaign_id, sequence)
);
CREATE TABLE IF NOT EXISTS campaign_processed_commands (
  guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, outcome TEXT NOT NULL,
  PRIMARY KEY (guild_id, campaign_id, command_id)
);
CREATE TABLE IF NOT EXISTS campaign_outbox (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, kind TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, last_error TEXT
);
CREATE INDEX IF NOT EXISTS campaign_outbox_pending ON campaign_outbox (status, kind);
CREATE TABLE IF NOT EXISTS campaign_timers (
  guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, timer_id TEXT NOT NULL, due_at INTEGER NOT NULL,
  timer TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (guild_id, campaign_id, timer_id)
);
CREATE INDEX IF NOT EXISTS campaign_timers_due ON campaign_timers (status, due_at);
CREATE TABLE IF NOT EXISTS campaign_rolls (
  guild_id TEXT NOT NULL, campaign_id TEXT NOT NULL, roll_id TEXT NOT NULL, result TEXT NOT NULL, rolled_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, campaign_id, roll_id)
);
`;

type Row = Record<string, unknown>;

// The durable campaign store. better-sqlite3 is one synchronous connection, so
// a transaction is BEGIN IMMEDIATE .. COMMIT around the caller's work, with
// transactions in this process serialized; a rollback leaves nothing behind.
export class SqliteCampaignStore implements CampaignUnitOfWork {
  private readonly lock = new KeyedSerialQueue();

  public constructor(private readonly database: Database) {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(schema);
    const row = database.prepare("SELECT version FROM campaign_meta").get() as { version: number } | undefined;
    if (row === undefined) database.prepare("INSERT INTO campaign_meta (version) VALUES (?)").run(schemaVersion);
    // Version 1 only lacked the record table, which the schema above just added.
    else if (row.version === 1) database.prepare("UPDATE campaign_meta SET version = ?").run(schemaVersion);
    else if (row.version !== schemaVersion) throw new Error(`Campaign schema version ${row.version} is not supported (expected ${schemaVersion}).`);
  }

  public transaction<T>(work: (tx: CampaignTransaction) => Promise<T>): Promise<T> {
    return this.lock.run("store", async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(new SqliteTransaction(this.database));
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }
}

class SqliteTransaction implements CampaignTransaction {
  public constructor(private readonly db: Database) {}

  public loadCampaign(key: CampaignKey): Promise<StoredCampaign | undefined> {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE guild_id = ? AND campaign_id = ?").get(key.guildId, key.campaignId) as Row | undefined;
    return Promise.resolve(
      row === undefined
        ? undefined
        : {
            state: parse<CampaignState>(row.state),
            revision: row.revision as number,
            ruleset: parse(row.ruleset),
            adventure: parse(row.adventure),
          },
    );
  }

  public createCampaign(key: CampaignKey, campaign: StoredCampaign): Promise<void> {
    if (this.db.prepare("SELECT 1 FROM campaigns WHERE guild_id = ? AND campaign_id = ?").get(key.guildId, key.campaignId) !== undefined) {
      return Promise.reject(new Error(`Campaign ${key.campaignId} already exists.`));
    }
    this.db
      .prepare("INSERT INTO campaigns (guild_id, campaign_id, revision, state, ruleset, adventure) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key.guildId, key.campaignId, campaign.revision, json(campaign.state), json(campaign.ruleset), json(campaign.adventure));
    return Promise.resolve();
  }

  public saveCampaign(key: CampaignKey, state: CampaignState, expectedRevision: number): Promise<number> {
    const row = this.db.prepare("SELECT revision FROM campaigns WHERE guild_id = ? AND campaign_id = ?").get(key.guildId, key.campaignId) as
      | { revision: number }
      | undefined;
    if (row === undefined) return Promise.reject(new Error(`Campaign ${key.campaignId} does not exist.`));
    if (row.revision !== expectedRevision) return Promise.reject(new RevisionConflictError(key, expectedRevision, row.revision));
    const revision = row.revision + 1;
    this.db.prepare("UPDATE campaigns SET state = ?, revision = ? WHERE guild_id = ? AND campaign_id = ?").run(json(state), revision, key.guildId, key.campaignId);
    return Promise.resolve(revision);
  }

  public appendEvents(key: CampaignKey, events: readonly Omit<EventEnvelope, "sequence">[]): Promise<void> {
    const last = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM campaign_events WHERE guild_id = ? AND campaign_id = ?").get(key.guildId, key.campaignId) as {
      last: number;
    };
    const insert = this.db.prepare("INSERT INTO campaign_events (guild_id, campaign_id, sequence, envelope) VALUES (?, ?, ?, ?)");
    events.forEach((event, index) => {
      const sequence = last.last + index + 1;
      insert.run(key.guildId, key.campaignId, sequence, json({ ...event, sequence }));
    });
    return Promise.resolve();
  }

  public readEvents(key: CampaignKey): Promise<readonly EventEnvelope[]> {
    const rows = this.db.prepare("SELECT envelope FROM campaign_events WHERE guild_id = ? AND campaign_id = ? ORDER BY sequence").all(key.guildId, key.campaignId) as Row[];
    return Promise.resolve(rows.map((row) => parse<EventEnvelope>(row.envelope)));
  }

  public findProcessedCommand(key: CampaignKey, commandId: string): Promise<CommandOutcome | undefined> {
    const row = this.db
      .prepare("SELECT outcome FROM campaign_processed_commands WHERE guild_id = ? AND campaign_id = ? AND command_id = ?")
      .get(key.guildId, key.campaignId, commandId) as Row | undefined;
    return Promise.resolve(row === undefined ? undefined : parse<CommandOutcome>(row.outcome));
  }

  public recordProcessedCommand(key: CampaignKey, commandId: string, outcome: CommandOutcome): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO campaign_processed_commands (guild_id, campaign_id, command_id, outcome) VALUES (?, ?, ?, ?)")
      .run(key.guildId, key.campaignId, commandId, json(outcome));
    return Promise.resolve();
  }

  public enqueue(key: CampaignKey, id: string, request: OutboxRequest, now: number): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO campaign_outbox (id, guild_id, campaign_id, kind, request, status, attempts, created_at, last_error) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL)")
      .run(id, key.guildId, key.campaignId, request.kind, json(request), now);
    return Promise.resolve();
  }

  public pendingOutbox(kind: OutboxRequest["kind"]): Promise<readonly OutboxItem[]> {
    const rows = this.db.prepare("SELECT * FROM campaign_outbox WHERE status = 'pending' AND kind = ? ORDER BY rowid").all(kind) as Row[];
    return Promise.resolve(
      rows.map((row) => ({
        id: row.id as string,
        key: { guildId: row.guild_id as string, campaignId: row.campaign_id as string },
        request: parse<OutboxRequest>(row.request),
        status: row.status as OutboxItem["status"],
        attempts: row.attempts as number,
        createdAt: row.created_at as number,
        lastError: (row.last_error as string | null) ?? null,
      })),
    );
  }

  public completeOutbox(id: string): Promise<void> {
    this.db.prepare("UPDATE campaign_outbox SET status = 'done' WHERE id = ?").run(id);
    return Promise.resolve();
  }

  public failOutboxAttempt(id: string, error: string, maxAttempts: number): Promise<void> {
    this.db
      .prepare("UPDATE campaign_outbox SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?")
      .run(error, maxAttempts, id);
    return Promise.resolve();
  }

  public scheduleTimer(key: CampaignKey, timer: TimerSpec): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO campaign_timers (guild_id, campaign_id, timer_id, due_at, timer, status) VALUES (?, ?, ?, ?, ?, 'pending')")
      .run(key.guildId, key.campaignId, timer.timerId, timer.dueAt, json(timer));
    return Promise.resolve();
  }

  public cancelTimer(key: CampaignKey, timerId: string): Promise<void> {
    this.db
      .prepare("UPDATE campaign_timers SET status = 'cancelled' WHERE guild_id = ? AND campaign_id = ? AND timer_id = ? AND status = 'pending'")
      .run(key.guildId, key.campaignId, timerId);
    return Promise.resolve();
  }

  public dueTimers(now: number): Promise<readonly TimerRecord[]> {
    const rows = this.db.prepare("SELECT * FROM campaign_timers WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, rowid").all(now) as Row[];
    return Promise.resolve(
      rows.map((row) => ({
        key: { guildId: row.guild_id as string, campaignId: row.campaign_id as string },
        timer: parse<TimerSpec>(row.timer),
        status: row.status as TimerRecord["status"],
      })),
    );
  }

  public markTimerFired(key: CampaignKey, timerId: string): Promise<void> {
    this.db
      .prepare("UPDATE campaign_timers SET status = 'fired' WHERE guild_id = ? AND campaign_id = ? AND timer_id = ? AND status = 'pending'")
      .run(key.guildId, key.campaignId, timerId);
    return Promise.resolve();
  }

  public createRecord(record: CampaignRecord): Promise<void> {
    const { guildId, campaignId } = record.key;
    if (this.db.prepare("SELECT 1 FROM campaign_records WHERE guild_id = ? AND campaign_id = ?").get(guildId, campaignId) !== undefined) {
      return Promise.reject(new Error(`Campaign ${campaignId} already exists.`));
    }
    this.db
      .prepare("INSERT INTO campaign_records (guild_id, campaign_id, revision, lifecycle, record) VALUES (?, ?, 0, ?, ?)")
      .run(guildId, campaignId, record.lifecycle, json(record));
    return Promise.resolve();
  }

  public loadRecord(key: CampaignKey): Promise<StoredRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM campaign_records WHERE guild_id = ? AND campaign_id = ?").get(key.guildId, key.campaignId) as Row | undefined;
    return Promise.resolve(row === undefined ? undefined : toStoredRecord(row));
  }

  public saveRecord(record: CampaignRecord, expectedRevision: number): Promise<number> {
    const { guildId, campaignId } = record.key;
    const row = this.db.prepare("SELECT revision FROM campaign_records WHERE guild_id = ? AND campaign_id = ?").get(guildId, campaignId) as
      | { revision: number }
      | undefined;
    if (row === undefined) return Promise.reject(new Error(`Campaign ${campaignId} does not exist.`));
    if (row.revision !== expectedRevision) return Promise.reject(new RevisionConflictError(record.key, expectedRevision, row.revision));
    const revision = row.revision + 1;
    this.db
      .prepare("UPDATE campaign_records SET record = ?, lifecycle = ?, revision = ? WHERE guild_id = ? AND campaign_id = ?")
      .run(json(record), record.lifecycle, revision, guildId, campaignId);
    return Promise.resolve(revision);
  }

  public listRecords(guildId: string, lifecycles?: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]> {
    const rows = this.db.prepare("SELECT * FROM campaign_records WHERE guild_id = ? ORDER BY rowid").all(guildId) as Row[];
    return Promise.resolve(rows.map(toStoredRecord).filter((stored) => lifecycles === undefined || lifecycles.includes(stored.record.lifecycle)));
  }

  public listRecordsByLifecycle(lifecycles: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]> {
    const rows = this.db.prepare("SELECT * FROM campaign_records ORDER BY rowid").all() as Row[];
    return Promise.resolve(rows.map(toStoredRecord).filter((stored) => lifecycles.includes(stored.record.lifecycle)));
  }

  public loadGuildSettings(guildId: string): Promise<GuildCampaignSettings | undefined> {
    const row = this.db.prepare("SELECT settings FROM campaign_guild_settings WHERE guild_id = ?").get(guildId) as Row | undefined;
    return Promise.resolve(row === undefined ? undefined : parse<GuildCampaignSettings>(row.settings));
  }

  public saveGuildSettings(settings: GuildCampaignSettings): Promise<void> {
    this.db
      .prepare("INSERT INTO campaign_guild_settings (guild_id, settings) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET settings = excluded.settings")
      .run(settings.guildId, json(settings));
    return Promise.resolve();
  }

  public findRoll(key: CampaignKey, rollId: string): Promise<SavedRoll | undefined> {
    const row = this.db.prepare("SELECT * FROM campaign_rolls WHERE guild_id = ? AND campaign_id = ? AND roll_id = ?").get(key.guildId, key.campaignId, rollId) as Row | undefined;
    return Promise.resolve(row === undefined ? undefined : toRoll(row));
  }

  // Written once; saving an existing roll ID keeps the first result.
  public saveRoll(roll: SavedRoll): Promise<SavedRoll> {
    this.db
      .prepare("INSERT OR IGNORE INTO campaign_rolls (guild_id, campaign_id, roll_id, result, rolled_at) VALUES (?, ?, ?, ?, ?)")
      .run(roll.key.guildId, roll.key.campaignId, roll.rollId, json(roll.result), roll.rolledAt);
    const row = this.db.prepare("SELECT * FROM campaign_rolls WHERE guild_id = ? AND campaign_id = ? AND roll_id = ?").get(roll.key.guildId, roll.key.campaignId, roll.rollId) as Row;
    return Promise.resolve(toRoll(row));
  }
}

function toStoredRecord(row: Row): StoredRecord {
  return { record: parse<CampaignRecord>(row.record), revision: row.revision as number };
}

function toRoll(row: Row): SavedRoll {
  return {
    key: { guildId: row.guild_id as string, campaignId: row.campaign_id as string },
    rollId: row.roll_id as string,
    result: parse(row.result),
    rolledAt: row.rolled_at as number,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown): T {
  return JSON.parse(value as string) as T;
}
