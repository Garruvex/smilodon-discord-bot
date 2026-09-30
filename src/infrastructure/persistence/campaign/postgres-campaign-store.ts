import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import type { StoredAdventure } from "../../../application/campaign/adventures/stored-adventure.js";
import type { LibraryCharacter, LibrarySnapshot } from "../../../application/campaign/library/library-types.js";
import type { CampaignLifecycle, CampaignRecord, GuildCampaignSettings, StoredRecord } from "../../../application/campaign/ports/campaign-record.js";
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
import type { TimerSpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import * as schema from "../../database/schema.js";

type Database = PostgresJsDatabase<typeof schema>;
// What a drizzle transaction hands its callback.
type Executor = Parameters<Parameters<Database["transaction"]>[0]>[0];

const t = schema;

// The durable campaign store on PostgreSQL (plan §9, milestone 6): the same
// contract as the SQLite store, run against the same tests. A transaction is a
// real database transaction; the ones in this process are also taken one at a
// time, exactly as the SQLite store does, so the compare-and-set on each
// revision only ever has to arbitrate between a restart and a retry, never
// between two live writers of one process. The tables come from the Drizzle
// migrations (npm run instance:db:migrate); this class creates nothing.
export class PostgresCampaignStore implements CampaignUnitOfWork {
  private readonly lock = new KeyedSerialQueue();
  private database: Promise<Database> | null = null;

  // The database is opened on first use, so building the campaign module
  // touches no network (command deployment builds it too).
  public constructor(private readonly open: () => Promise<Database>) {}

  // Opens the connection now, so a wrong address or a missing table fails at startup.
  public async ready(): Promise<void> {
    this.database ??= this.open();
    await this.database;
  }

  public transaction<T>(work: (tx: CampaignTransaction) => Promise<T>): Promise<T> {
    return this.lock.run("store", async () => {
      this.database ??= this.open();
      const database = await this.database;
      return database.transaction((executor) => work(new PostgresTransaction(executor)));
    });
  }
}

class PostgresTransaction implements CampaignTransaction {
  public constructor(private readonly db: Executor) {}

  // ---- engine campaign

  public async loadCampaign(key: CampaignKey): Promise<StoredCampaign | undefined> {
    const [row] = await this.db.select().from(t.campaignCampaigns).where(and(eq(t.campaignCampaigns.guildId, key.guildId), eq(t.campaignCampaigns.campaignId, key.campaignId)));
    return row === undefined ? undefined : { state: row.state as CampaignState, revision: row.revision, ruleset: row.ruleset as StoredCampaign["ruleset"], adventure: row.adventure as StoredCampaign["adventure"] };
  }

  public async createCampaign(key: CampaignKey, campaign: StoredCampaign): Promise<void> {
    const inserted = await this.db
      .insert(t.campaignCampaigns)
      .values({ guildId: key.guildId, campaignId: key.campaignId, revision: campaign.revision, state: campaign.state, ruleset: campaign.ruleset, adventure: campaign.adventure })
      .onConflictDoNothing()
      .returning({ id: t.campaignCampaigns.campaignId });
    if (inserted.length === 0) throw new Error(`Campaign ${key.campaignId} already exists.`);
  }

  public async saveCampaign(key: CampaignKey, state: CampaignState, expectedRevision: number): Promise<number> {
    const where = and(eq(t.campaignCampaigns.guildId, key.guildId), eq(t.campaignCampaigns.campaignId, key.campaignId));
    // One statement compares and swaps: no other writer can slip between them.
    const updated = await this.db
      .update(t.campaignCampaigns)
      .set({ state, revision: sql`${t.campaignCampaigns.revision} + 1` })
      .where(and(where, eq(t.campaignCampaigns.revision, expectedRevision)))
      .returning({ revision: t.campaignCampaigns.revision });
    if (updated[0] !== undefined) return updated[0].revision;
    const [current] = await this.db.select({ revision: t.campaignCampaigns.revision }).from(t.campaignCampaigns).where(where);
    if (current === undefined) throw new Error(`Campaign ${key.campaignId} does not exist.`);
    throw new RevisionConflictError(key, expectedRevision, current.revision);
  }

  // ---- events and processed commands

  public async appendEvents(key: CampaignKey, events: readonly Omit<EventEnvelope, "sequence">[]): Promise<void> {
    const [last] = await this.db
      .select({ last: sql<number>`coalesce(max(${t.campaignEvents.sequence}), 0)` })
      .from(t.campaignEvents)
      .where(and(eq(t.campaignEvents.guildId, key.guildId), eq(t.campaignEvents.campaignId, key.campaignId)));
    const base = Number(last?.last ?? 0);
    if (events.length === 0) return;
    await this.db.insert(t.campaignEvents).values(events.map((event, index) => ({ guildId: key.guildId, campaignId: key.campaignId, sequence: base + index + 1, envelope: { ...event, sequence: base + index + 1 } })));
  }

  public async readEvents(key: CampaignKey): Promise<readonly EventEnvelope[]> {
    const rows = await this.db
      .select({ envelope: t.campaignEvents.envelope })
      .from(t.campaignEvents)
      .where(and(eq(t.campaignEvents.guildId, key.guildId), eq(t.campaignEvents.campaignId, key.campaignId)))
      .orderBy(asc(t.campaignEvents.sequence));
    return rows.map((row) => row.envelope as EventEnvelope);
  }

  public async findProcessedCommand(key: CampaignKey, commandId: string): Promise<CommandOutcome | undefined> {
    const [row] = await this.db
      .select({ outcome: t.campaignProcessedCommands.outcome })
      .from(t.campaignProcessedCommands)
      .where(and(eq(t.campaignProcessedCommands.guildId, key.guildId), eq(t.campaignProcessedCommands.campaignId, key.campaignId), eq(t.campaignProcessedCommands.commandId, commandId)));
    return row === undefined ? undefined : (row.outcome as CommandOutcome);
  }

  public async recordProcessedCommand(key: CampaignKey, commandId: string, outcome: CommandOutcome): Promise<void> {
    await this.db
      .insert(t.campaignProcessedCommands)
      .values({ guildId: key.guildId, campaignId: key.campaignId, commandId, outcome })
      .onConflictDoUpdate({ target: [t.campaignProcessedCommands.guildId, t.campaignProcessedCommands.campaignId, t.campaignProcessedCommands.commandId], set: { outcome } });
  }

  // ---- outbox

  public async enqueue(key: CampaignKey, id: string, request: OutboxRequest, now: number): Promise<void> {
    await this.db
      .insert(t.campaignOutbox)
      .values({ id, guildId: key.guildId, campaignId: key.campaignId, kind: request.kind, request, status: "pending", attempts: 0, createdAt: now, lastError: null, notBefore: 0 })
      .onConflictDoNothing();
  }

  public async pendingOutbox(kind: OutboxRequest["kind"]): Promise<readonly OutboxItem[]> {
    const rows = await this.db
      .select()
      .from(t.campaignOutbox)
      .where(and(eq(t.campaignOutbox.status, "pending"), eq(t.campaignOutbox.kind, kind)))
      .orderBy(asc(t.campaignOutbox.position));
    return rows.map((row) => ({
      id: row.id,
      key: { guildId: row.guildId, campaignId: row.campaignId },
      request: row.request as OutboxRequest,
      status: row.status as OutboxItem["status"],
      attempts: row.attempts,
      createdAt: row.createdAt,
      lastError: row.lastError,
      notBefore: row.notBefore,
    }));
  }

  public async outboxForCampaign(key: CampaignKey): Promise<readonly OutboxItem[]> {
    const rows = await this.db.select().from(t.campaignOutbox)
      .where(and(eq(t.campaignOutbox.guildId, key.guildId), eq(t.campaignOutbox.campaignId, key.campaignId)))
      .orderBy(asc(t.campaignOutbox.position));
    return rows.map((row) => ({ id: row.id, key, request: row.request as OutboxRequest, status: row.status as OutboxItem["status"], attempts: row.attempts, createdAt: row.createdAt, lastError: row.lastError, notBefore: row.notBefore }));
  }

  public async completeOutbox(id: string): Promise<void> {
    await this.db.update(t.campaignOutbox).set({ status: "done" }).where(eq(t.campaignOutbox.id, id));
  }

  public async failOutboxAttempt(id: string, error: string, maxAttempts: number, retryAt = 0): Promise<void> {
    await this.db
      .update(t.campaignOutbox)
      .set({
        attempts: sql`${t.campaignOutbox.attempts} + 1`,
        lastError: error,
        notBefore: retryAt,
        status: sql`case when ${t.campaignOutbox.attempts} + 1 >= ${maxAttempts} then 'failed' else 'pending' end`,
      })
      .where(eq(t.campaignOutbox.id, id));
  }

  public async requeueFailedOutbox(key: CampaignKey): Promise<number> {
    const updated = await this.db
      .update(t.campaignOutbox)
      .set({ status: "pending", attempts: 0, notBefore: 0 })
      .where(and(eq(t.campaignOutbox.guildId, key.guildId), eq(t.campaignOutbox.campaignId, key.campaignId), eq(t.campaignOutbox.status, "failed")))
      .returning({ id: t.campaignOutbox.id });
    return updated.length;
  }

  public async requeueFailedOutboxItem(key: CampaignKey, id: string): Promise<boolean> {
    const updated = await this.db.update(t.campaignOutbox).set({ status: "pending", attempts: 0, lastError: null, notBefore: 0 })
      .where(and(eq(t.campaignOutbox.guildId, key.guildId), eq(t.campaignOutbox.campaignId, key.campaignId), eq(t.campaignOutbox.id, id), eq(t.campaignOutbox.status, "failed")))
      .returning({ id: t.campaignOutbox.id });
    return updated.length > 0;
  }

  // ---- timers

  public async scheduleTimer(key: CampaignKey, timer: TimerSpec): Promise<void> {
    // Scheduling an ID that exists replaces it (and lets it fire again).
    await this.db
      .insert(t.campaignTimers)
      .values({ guildId: key.guildId, campaignId: key.campaignId, timerId: timer.timerId, dueAt: timer.dueAt, timer, status: "pending" })
      .onConflictDoUpdate({ target: [t.campaignTimers.guildId, t.campaignTimers.campaignId, t.campaignTimers.timerId], set: { dueAt: timer.dueAt, timer, status: "pending" } });
  }

  public async cancelTimer(key: CampaignKey, timerId: string): Promise<void> {
    await this.db
      .update(t.campaignTimers)
      .set({ status: "cancelled" })
      .where(and(eq(t.campaignTimers.guildId, key.guildId), eq(t.campaignTimers.campaignId, key.campaignId), eq(t.campaignTimers.timerId, timerId), eq(t.campaignTimers.status, "pending")));
  }

  public async dueTimers(now: number): Promise<readonly TimerRecord[]> {
    const rows = await this.db
      .select()
      .from(t.campaignTimers)
      .where(and(eq(t.campaignTimers.status, "pending"), lte(t.campaignTimers.dueAt, now)))
      .orderBy(asc(t.campaignTimers.dueAt), asc(t.campaignTimers.position));
    return rows.map((row) => ({ key: { guildId: row.guildId, campaignId: row.campaignId }, timer: row.timer as TimerSpec, status: row.status as TimerRecord["status"] }));
  }

  public async markTimerFired(key: CampaignKey, timerId: string): Promise<void> {
    await this.db
      .update(t.campaignTimers)
      .set({ status: "fired" })
      .where(and(eq(t.campaignTimers.guildId, key.guildId), eq(t.campaignTimers.campaignId, key.campaignId), eq(t.campaignTimers.timerId, timerId), eq(t.campaignTimers.status, "pending")));
  }

  // ---- records and settings

  public async createRecord(record: CampaignRecord): Promise<void> {
    const inserted = await this.db
      .insert(t.campaignRecords)
      .values({ guildId: record.key.guildId, campaignId: record.key.campaignId, revision: 0, lifecycle: record.lifecycle, record })
      .onConflictDoNothing()
      .returning({ id: t.campaignRecords.campaignId });
    if (inserted.length === 0) throw new Error(`Campaign ${record.key.campaignId} already exists.`);
  }

  public async loadRecord(key: CampaignKey): Promise<StoredRecord | undefined> {
    const [row] = await this.db.select().from(t.campaignRecords).where(and(eq(t.campaignRecords.guildId, key.guildId), eq(t.campaignRecords.campaignId, key.campaignId)));
    return row === undefined ? undefined : { record: row.record as CampaignRecord, revision: row.revision };
  }

  public async saveRecord(record: CampaignRecord, expectedRevision: number): Promise<number> {
    const { guildId, campaignId } = record.key;
    const where = and(eq(t.campaignRecords.guildId, guildId), eq(t.campaignRecords.campaignId, campaignId));
    const updated = await this.db
      .update(t.campaignRecords)
      .set({ record, lifecycle: record.lifecycle, revision: sql`${t.campaignRecords.revision} + 1` })
      .where(and(where, eq(t.campaignRecords.revision, expectedRevision)))
      .returning({ revision: t.campaignRecords.revision });
    if (updated[0] !== undefined) return updated[0].revision;
    const [current] = await this.db.select({ revision: t.campaignRecords.revision }).from(t.campaignRecords).where(where);
    if (current === undefined) throw new Error(`Campaign ${campaignId} does not exist.`);
    throw new RevisionConflictError(record.key, expectedRevision, current.revision);
  }

  public async listRecords(guildId: string, lifecycles?: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]> {
    const rows = await this.db.select().from(t.campaignRecords).where(eq(t.campaignRecords.guildId, guildId)).orderBy(asc(t.campaignRecords.position));
    return rows.map(toStoredRecord).filter((stored) => lifecycles === undefined || lifecycles.includes(stored.record.lifecycle));
  }

  public async listRecordsByLifecycle(lifecycles: readonly CampaignLifecycle[]): Promise<readonly StoredRecord[]> {
    if (lifecycles.length === 0) return [];
    const rows = await this.db.select().from(t.campaignRecords).where(inArray(t.campaignRecords.lifecycle, [...lifecycles])).orderBy(asc(t.campaignRecords.position));
    return rows.map(toStoredRecord);
  }

  public async loadGuildSettings(guildId: string): Promise<GuildCampaignSettings | undefined> {
    const [row] = await this.db.select({ settings: t.campaignGuildSettings.settings }).from(t.campaignGuildSettings).where(eq(t.campaignGuildSettings.guildId, guildId));
    return row === undefined ? undefined : (row.settings as GuildCampaignSettings);
  }

  public async listGuildSettings(): Promise<readonly GuildCampaignSettings[]> {
    const rows = await this.db.select({ settings: t.campaignGuildSettings.settings }).from(t.campaignGuildSettings).orderBy(asc(t.campaignGuildSettings.position));
    return rows.map((row) => row.settings as GuildCampaignSettings);
  }

  public async saveGuildSettings(settings: GuildCampaignSettings): Promise<void> {
    await this.db
      .insert(t.campaignGuildSettings)
      .values({ guildId: settings.guildId, settings })
      .onConflictDoUpdate({ target: t.campaignGuildSettings.guildId, set: { settings } });
  }

  // ---- character library

  public async saveLibraryCharacter(character: LibraryCharacter): Promise<void> {
    await this.db
      .insert(t.campaignLibraryCharacters)
      .values({ id: character.id, ownerUserId: character.ownerUserId, character })
      .onConflictDoUpdate({ target: t.campaignLibraryCharacters.id, set: { character } });
  }

  public async loadLibraryCharacter(id: string): Promise<LibraryCharacter | undefined> {
    const [row] = await this.db.select({ character: t.campaignLibraryCharacters.character }).from(t.campaignLibraryCharacters).where(eq(t.campaignLibraryCharacters.id, id));
    return row === undefined ? undefined : (row.character as LibraryCharacter);
  }

  public async listLibraryCharacters(ownerUserId: string): Promise<readonly LibraryCharacter[]> {
    const rows = await this.db
      .select({ character: t.campaignLibraryCharacters.character })
      .from(t.campaignLibraryCharacters)
      .where(eq(t.campaignLibraryCharacters.ownerUserId, ownerUserId))
      .orderBy(asc(t.campaignLibraryCharacters.position));
    return rows.map((row) => row.character as LibraryCharacter);
  }

  public async deleteLibraryCharacter(id: string): Promise<void> {
    await this.db.delete(t.campaignLibrarySnapshots).where(eq(t.campaignLibrarySnapshots.characterId, id));
    await this.db.delete(t.campaignLibraryCharacters).where(eq(t.campaignLibraryCharacters.id, id));
  }

  public async saveLibrarySnapshot(snapshot: LibrarySnapshot): Promise<void> {
    // Written once: an existing ID (or source key) keeps the first snapshot.
    await this.db
      .insert(t.campaignLibrarySnapshots)
      .values({ id: snapshot.id, characterId: snapshot.characterId, revision: snapshot.revision, sourceKey: snapshot.sourceKey, snapshot })
      .onConflictDoNothing();
  }

  public async loadLibrarySnapshot(id: string): Promise<LibrarySnapshot | undefined> {
    const [row] = await this.db.select({ snapshot: t.campaignLibrarySnapshots.snapshot }).from(t.campaignLibrarySnapshots).where(eq(t.campaignLibrarySnapshots.id, id));
    return row === undefined ? undefined : (row.snapshot as LibrarySnapshot);
  }

  public async listLibrarySnapshots(characterId: string): Promise<readonly LibrarySnapshot[]> {
    const rows = await this.db
      .select({ snapshot: t.campaignLibrarySnapshots.snapshot })
      .from(t.campaignLibrarySnapshots)
      .where(eq(t.campaignLibrarySnapshots.characterId, characterId))
      .orderBy(asc(t.campaignLibrarySnapshots.revision));
    return rows.map((row) => row.snapshot as LibrarySnapshot);
  }

  public async findLibrarySnapshotBySourceKey(characterId: string, sourceKey: string): Promise<LibrarySnapshot | undefined> {
    const [row] = await this.db
      .select({ snapshot: t.campaignLibrarySnapshots.snapshot })
      .from(t.campaignLibrarySnapshots)
      .where(and(eq(t.campaignLibrarySnapshots.characterId, characterId), eq(t.campaignLibrarySnapshots.sourceKey, sourceKey)));
    return row === undefined ? undefined : (row.snapshot as LibrarySnapshot);
  }

  // ---- adventures

  public async saveAdventure(adventure: StoredAdventure): Promise<void> {
    await this.db
      .insert(t.campaignAdventures)
      .values({ entryKey: adventure.key, guildId: adventure.guildId, status: adventure.status, adventure })
      .onConflictDoUpdate({ target: t.campaignAdventures.entryKey, set: { status: adventure.status, adventure } });
  }

  public async loadAdventure(key: string): Promise<StoredAdventure | undefined> {
    const [row] = await this.db.select({ adventure: t.campaignAdventures.adventure }).from(t.campaignAdventures).where(eq(t.campaignAdventures.entryKey, key));
    return row === undefined ? undefined : (row.adventure as StoredAdventure);
  }

  public async listAdventures(guildId: string, status?: StoredAdventure["status"]): Promise<readonly StoredAdventure[]> {
    const rows = await this.db
      .select({ adventure: t.campaignAdventures.adventure })
      .from(t.campaignAdventures)
      .where(status === undefined ? eq(t.campaignAdventures.guildId, guildId) : and(eq(t.campaignAdventures.guildId, guildId), eq(t.campaignAdventures.status, status)))
      .orderBy(asc(t.campaignAdventures.position));
    return rows.map((row) => row.adventure as StoredAdventure);
  }

  public async listAdventuresByStatus(status: StoredAdventure["status"]): Promise<readonly StoredAdventure[]> {
    const rows = await this.db.select({ adventure: t.campaignAdventures.adventure }).from(t.campaignAdventures).where(eq(t.campaignAdventures.status, status)).orderBy(asc(t.campaignAdventures.position));
    return rows.map((row) => row.adventure as StoredAdventure);
  }

  // ---- rolls

  public async findRoll(key: CampaignKey, rollId: string): Promise<SavedRoll | undefined> {
    const [row] = await this.db
      .select()
      .from(t.campaignRolls)
      .where(and(eq(t.campaignRolls.guildId, key.guildId), eq(t.campaignRolls.campaignId, key.campaignId), eq(t.campaignRolls.rollId, rollId)));
    return row === undefined ? undefined : toRoll(row);
  }

  // Written once; saving an existing roll ID keeps the first result.
  public async saveRoll(roll: SavedRoll): Promise<SavedRoll> {
    await this.db
      .insert(t.campaignRolls)
      .values({ guildId: roll.key.guildId, campaignId: roll.key.campaignId, rollId: roll.rollId, result: roll.result, rolledAt: roll.rolledAt })
      .onConflictDoNothing();
    const saved = await this.findRoll(roll.key, roll.rollId);
    if (saved === undefined) throw new Error(`Roll ${roll.rollId} was not saved.`);
    return saved;
  }
}

function toStoredRecord(row: { record: unknown; revision: number }): StoredRecord {
  return { record: row.record as CampaignRecord, revision: row.revision };
}

function toRoll(row: { guildId: string; campaignId: string; rollId: string; result: unknown; rolledAt: number }): SavedRoll {
  return { key: { guildId: row.guildId, campaignId: row.campaignId }, rollId: row.rollId, result: row.result as SavedRoll["result"], rolledAt: row.rolledAt };
}
