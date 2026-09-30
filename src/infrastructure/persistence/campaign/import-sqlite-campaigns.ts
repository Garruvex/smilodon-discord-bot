import type { Database } from "better-sqlite3";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../../database/schema.js";

type Row = Record<string, unknown>;

export interface ImportCounts {
  readonly campaigns: number;
  readonly records: number;
  readonly guildSettings: number;
  readonly events: number;
  readonly processedCommands: number;
  readonly outbox: number;
  readonly timers: number;
  readonly rolls: number;
  readonly libraryCharacters: number;
  readonly librarySnapshots: number;
  readonly adventures: number;
}

const has = (sqlite: Database, table: string): boolean => sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
const rowsOf = (sqlite: Database, table: string, order = "rowid"): Row[] => (has(sqlite, table) ? (sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[]) : []);
const parse = (value: unknown): unknown => JSON.parse(value as string);

// Copies a SQLite campaign database (what the bot used until milestone 6)
// into the PostgreSQL campaign tables, so games in progress carry on where
// they were after the switch. Rows are copied in their original order (which
// keeps the creation order the hub lists games in), and one that is already
// there is left alone, so running it twice, or after a few games were
// started on PostgreSQL, changes nothing that exists. Everything happens in
// one transaction: it copies all or nothing.
export async function importSqliteCampaigns(sqlite: Database, database: PostgresJsDatabase<typeof schema>): Promise<ImportCounts> {
  return database.transaction(async (tx) => {
    let campaigns = 0;
    for (const row of rowsOf(sqlite, "campaigns")) {
      const inserted = await tx
        .insert(schema.campaignCampaigns)
        .values({ guildId: row.guild_id as string, campaignId: row.campaign_id as string, revision: row.revision as number, state: parse(row.state), ruleset: parse(row.ruleset), adventure: parse(row.adventure) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignCampaigns.campaignId });
      campaigns += inserted.length;
    }
    let records = 0;
    for (const row of rowsOf(sqlite, "campaign_records")) {
      const inserted = await tx
        .insert(schema.campaignRecords)
        .values({ guildId: row.guild_id as string, campaignId: row.campaign_id as string, revision: row.revision as number, lifecycle: row.lifecycle as string, record: parse(row.record) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignRecords.campaignId });
      records += inserted.length;
    }
    let guildSettings = 0;
    for (const row of rowsOf(sqlite, "campaign_guild_settings")) {
      const inserted = await tx.insert(schema.campaignGuildSettings).values({ guildId: row.guild_id as string, settings: parse(row.settings) }).onConflictDoNothing().returning({ id: schema.campaignGuildSettings.guildId });
      guildSettings += inserted.length;
    }
    let events = 0;
    for (const row of rowsOf(sqlite, "campaign_events", "guild_id, campaign_id, sequence")) {
      const inserted = await tx
        .insert(schema.campaignEvents)
        .values({ guildId: row.guild_id as string, campaignId: row.campaign_id as string, sequence: row.sequence as number, envelope: parse(row.envelope) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignEvents.sequence });
      events += inserted.length;
    }
    let processedCommands = 0;
    for (const row of rowsOf(sqlite, "campaign_processed_commands")) {
      const inserted = await tx
        .insert(schema.campaignProcessedCommands)
        .values({ guildId: row.guild_id as string, campaignId: row.campaign_id as string, commandId: row.command_id as string, outcome: parse(row.outcome) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignProcessedCommands.commandId });
      processedCommands += inserted.length;
    }
    let outbox = 0;
    for (const row of rowsOf(sqlite, "campaign_outbox")) {
      const inserted = await tx
        .insert(schema.campaignOutbox)
        .values({
          id: row.id as string,
          guildId: row.guild_id as string,
          campaignId: row.campaign_id as string,
          kind: row.kind as string,
          request: parse(row.request),
          status: row.status as string,
          attempts: row.attempts as number,
          createdAt: row.created_at as number,
          lastError: (row.last_error as string | null) ?? null,
          notBefore: (row.not_before as number | undefined) ?? 0,
        })
        .onConflictDoNothing()
        .returning({ id: schema.campaignOutbox.id });
      outbox += inserted.length;
    }
    let timers = 0;
    for (const row of rowsOf(sqlite, "campaign_timers")) {
      const inserted = await tx
        .insert(schema.campaignTimers)
        .values({ guildId: row.guild_id as string, campaignId: row.campaign_id as string, timerId: row.timer_id as string, dueAt: row.due_at as number, timer: parse(row.timer), status: row.status as string })
        .onConflictDoNothing()
        .returning({ id: schema.campaignTimers.timerId });
      timers += inserted.length;
    }
    let rolls = 0;
    for (const row of rowsOf(sqlite, "campaign_rolls")) {
      const inserted = await tx
        .insert(schema.campaignRolls)
        .values({ guildId: row.guild_id as string, campaignId: row.campaign_id as string, rollId: row.roll_id as string, result: parse(row.result), rolledAt: row.rolled_at as number })
        .onConflictDoNothing()
        .returning({ id: schema.campaignRolls.rollId });
      rolls += inserted.length;
    }
    let libraryCharacters = 0;
    for (const row of rowsOf(sqlite, "library_characters")) {
      const inserted = await tx
        .insert(schema.campaignLibraryCharacters)
        .values({ id: row.id as string, ownerUserId: row.owner_user_id as string, character: parse(row.character) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignLibraryCharacters.id });
      libraryCharacters += inserted.length;
    }
    let librarySnapshots = 0;
    for (const row of rowsOf(sqlite, "library_snapshots")) {
      const inserted = await tx
        .insert(schema.campaignLibrarySnapshots)
        .values({ id: row.id as string, characterId: row.character_id as string, revision: row.revision as number, sourceKey: row.source_key as string, snapshot: parse(row.snapshot) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignLibrarySnapshots.id });
      librarySnapshots += inserted.length;
    }
    let adventures = 0;
    for (const row of rowsOf(sqlite, "campaign_adventures")) {
      const inserted = await tx
        .insert(schema.campaignAdventures)
        .values({ entryKey: row.entry_key as string, guildId: row.guild_id as string, status: row.status as string, adventure: parse(row.adventure) })
        .onConflictDoNothing()
        .returning({ id: schema.campaignAdventures.entryKey });
      adventures += inserted.length;
    }
    return { campaigns, records, guildSettings, events, processedCommands, outbox, timers, rolls, libraryCharacters, librarySnapshots, adventures };
  });
}
