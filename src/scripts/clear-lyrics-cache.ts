import { ilike } from "drizzle-orm";

import { loadConfiguration } from "../config/environment.js";
import {
  createDatabaseConnection,
  resolveInstanceSchemaName,
} from "../infrastructure/database/database.js";
import * as schema from "../infrastructure/database/schema.js";

// The shared lyrics cache (see postgres-lyrics-cache-store.ts) now expires
// negative ("not found") results on its own after 30 days, but a row cached
// wrong before that fix — or before any other matching-logic fix — stays
// wrong until then. This forces an immediate re-check for specific tracks
// instead of waiting out the TTL.
const query = process.argv[2];
if (!query) {
  throw new Error(
    "Usage: tsx src/scripts/clear-lyrics-cache.ts <substring-of-title-or-artist>",
  );
}

const configuration = loadConfiguration();
if (configuration.persistence.driver !== "postgres" || !configuration.persistence.databaseUrl) {
  throw new Error("PostgreSQL persistence and DATABASE_URL are required — the lyrics cache doesn't exist on the local driver.");
}
if (!configuration.instanceName) {
  throw new Error("INSTANCE_NAME is required for PostgreSQL schema isolation.");
}

const connection = await createDatabaseConnection(
  configuration.persistence.databaseUrl,
  resolveInstanceSchemaName(configuration.instanceName),
);
try {
  const matches = await connection.database
    .select()
    .from(schema.cachedLyrics)
    .where(ilike(schema.cachedLyrics.trackKey, `%${query}%`));

  if (matches.length === 0) {
    process.stdout.write(`No cache entries match "${query}".\n`);
  } else {
    for (const row of matches) {
      const summary = row.lines === null ? "not-found" : `${(row.lines as unknown[]).length} lines`;
      process.stdout.write(`  ${row.trackKey} -> ${summary}\n`);
    }
    await connection.database
      .delete(schema.cachedLyrics)
      .where(ilike(schema.cachedLyrics.trackKey, `%${query}%`));
    process.stdout.write(`Deleted ${matches.length} entr${matches.length === 1 ? "y" : "ies"} matching "${query}".\n`);
  }
} finally {
  await connection.close();
}
