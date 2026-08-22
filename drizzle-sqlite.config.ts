import { defineConfig } from "drizzle-kit";

// Local (dev-only) SQLite backend — see sqlite-database.ts, which applies
// these migrations programmatically at store initialize() time. Separate
// from drizzle.config.ts (the Postgres schema/migrations), since the two
// backends have different table shapes for the tables they share (see
// sqlite-schema.ts's header comment).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infrastructure/database/sqlite-schema.ts",
  out: "./drizzle-sqlite",
  dbCredentials: { url: "./drizzle-sqlite/generate.sqlite" },
  strict: true,
  verbose: true,
});
