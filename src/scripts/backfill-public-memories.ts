import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { REST, Routes } from "discord.js";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as postgresDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { planPublicMemoryBackfill, type VerifiedHumanMessage } from "../application/memory/public-memory-backfill.js";
import { resolveChannelMemoryMode } from "../application/memory/memory-channel-policy.js";
import type { MemoryRepository } from "../application/memory/memory.js";
import { loadConfiguration } from "../config/environment.js";
import { LocalGuildConfigurationProvider, type GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import { resolveInstanceSchemaName } from "../infrastructure/database/database.js";
import * as sqliteSchema from "../infrastructure/database/sqlite-schema.js";
import * as pgSchema from "../infrastructure/database/schema.js";
import { SqliteMemoryRepository } from "../infrastructure/persistence/sqlite-memory-repository.js";
import { PostgresMemoryRepository } from "../infrastructure/persistence/postgres-memory-repository.js";
import { PostgresGuildConfigurationProvider } from "../infrastructure/persistence/postgres-guild-configuration-provider.js";

const snowflake = z.string().regex(/^\d{17,20}$/);
const manifestSchema = z.object({
  adminReviewedHistoricalVisibility: z.literal(true),
  entries: z.array(z.object({ guildId: snowflake, memoryId: z.string().uuid(), sourceMessageId: snowflake,
    sourceChannelId: snowflake, historicalMode: z.enum(["shared", "isolated"]), sourceQuote: z.string().trim().min(1), approved: z.literal(true) })).max(1000),
});
const channelSchema = z.object({ guild_id: snowflake });
const messageSchema = z.object({ id: snowflake, channel_id: snowflake, content: z.string(), timestamp: z.string(),
  author: z.object({ id: snowflake, bot: z.boolean().optional() }) });

// Dry-run is the default and uses a read-only connection. It never applies
// schema migrations or creates a database/schema. Deploy/migrate first.
export async function backfillPublicMemories(args = process.argv.slice(2)): Promise<void> {
  const manifestIndex = args.indexOf("--manifest");
  const manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : null;
  if (!manifestPath) throw new Error("Usage: --manifest <reviewed.json> [--apply]");
  const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(manifestPath), "utf8")));
  const apply = args.includes("--apply");
  const configuration = loadConfiguration();
  let repository: MemoryRepository;
  let profiles: GuildConfigurationProvider;
  let close: () => Promise<void>;
  if (configuration.persistence.driver === "postgres") {
    if (!configuration.persistence.databaseUrl || !configuration.instanceName) throw new Error("Select the configured PostgreSQL instance.");
    const client = postgres(configuration.persistence.databaseUrl, { max: 1, connection: {
      search_path: `${resolveInstanceSchemaName(configuration.instanceName)},public`, default_transaction_read_only: !apply,
    } });
    const database = postgresDrizzle(client, { schema: pgSchema });
    repository = new PostgresMemoryRepository(database);
    profiles = new PostgresGuildConfigurationProvider(database);
    close = async (): Promise<void> => { await client.end(); };
  } else {
    const client = new Database(resolve(configuration.runtimeDataDirectory, "chat.sqlite"), { readonly: !apply, fileMustExist: true });
    repository = new SqliteMemoryRepository(sqliteDrizzle(client, { schema: sqliteSchema }));
    profiles = new LocalGuildConfigurationProvider(configuration.guildConfigurationDirectory);
    close = (): Promise<void> => { client.close(); return Promise.resolve(); };
  }
  const rest = new REST({ version: "10" }).setToken(configuration.discord.token);
  const report: Record<string, unknown>[] = [];
  try {
    await profiles.initialize();
    for (const entry of manifest.entries) {
      let original: VerifiedHumanMessage | null = null;
      try {
        const channel = channelSchema.parse(await rest.get(Routes.channel(entry.sourceChannelId)));
        const message = messageSchema.parse(await rest.get(Routes.channelMessage(entry.sourceChannelId, entry.sourceMessageId)));
        if (Number.isFinite(Date.parse(message.timestamp))) original = { guildId: channel.guild_id,
          channelId: message.channel_id, messageId: message.id, authorId: message.author.id,
          authorIsBot: message.author.bot ?? false, content: message.content, timestampMs: Date.parse(message.timestamp) };
      } catch { /* Missing/deleted/unavailable sources remain at their existing audience. */ }
      const profile = profiles.find(entry.guildId);
      const mode = profile?.chat.sharedMemoryEnabled ? resolveChannelMemoryMode(profile.chat.channelMemoryModes, entry.sourceChannelId) : "disabled";
      const plan = await planPublicMemoryBackfill(repository, entry, original, mode);
      const item: Record<string, unknown> = { memoryId: plan.memoryId, eligible: plan.eligible, reason: plan.reason };
      if (plan.eligible) {
        item.scope = plan.scope;
        if (apply) {
          try { item.applied = await repository.reclassifyPublicMemory(plan.command); }
          catch { item.applied = false; item.reason = "concurrent_change_or_identity_conflict_review_required"; }
        }
      }
      report.push(item);
    }
    process.stdout.write(JSON.stringify({ mode: apply ? "apply" : "dry_run", records: report }, null, 2) + "\n");
  } finally { await close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await backfillPublicMemories();
