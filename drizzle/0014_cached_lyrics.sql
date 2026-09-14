-- Deliberately targets the shared "public" schema, not this instance's own
-- schema (unlike every other migration here) — see cachedLyrics in
-- schema.ts. IF NOT EXISTS makes this idempotent across instances: each
-- instance's migration history is independent, so both yohta's and
-- pinecone's migration runs execute this same statement once each.
CREATE TABLE IF NOT EXISTS "public"."cached_lyrics" (
	"track_key" text PRIMARY KEY NOT NULL,
	"lines" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
