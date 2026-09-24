-- Hand-edited after drizzle-kit generate: the data fix-ups below must run
-- before the (now effective) unique indexes are created.
--
-- 1. Collapse duplicate active rows per identity. The previous
--    memories_identity index indexed nullable columns raw, so it never
--    fired; keep the most recently updated row and mark the rest superseded
--    by it.
WITH "ranked" AS (
  SELECT "id",
    first_value("id") OVER "w" AS "keep_id",
    row_number() OVER "w" AS "rn"
  FROM "memories"
  WHERE "status" = 'active'
  WINDOW "w" AS (
    PARTITION BY "guild_id", coalesce("owner_user_id", ''), coalesce("channel_id", ''), coalesce("isolation_channel_id", ''),
      "subject_type", "subject_id", "topic", "slot"
    ORDER BY "updated_at" DESC, "id" DESC
  )
)
UPDATE "memories" SET "status" = 'superseded', "superseded_by_id" = "ranked"."keep_id",
  "valid_until" = now(), "updated_at" = now()
FROM "ranked" WHERE "memories"."id" = "ranked"."id" AND "ranked"."rn" > 1;--> statement-breakpoint
-- 2. Collapse duplicate relation edges, keeping the earliest.
DELETE FROM "memory_relations" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "guild_id", "from_subject_type", "from_subject_id", "predicate", "kind",
        "to_subject_type", "to_subject_id", coalesce("isolation_channel_id", '')
      ORDER BY "created_at", "id"
    ) AS "rn" FROM "memory_relations"
  ) AS "numbered" WHERE "rn" > 1
);--> statement-breakpoint
-- 3. Give pre-existing candidates the default candidate TTL (30 days from
--    creation, MEMORY_CANDIDATE_TTL_DAYS' default) so they can age out.
UPDATE "memories" SET "expires_at" = "created_at" + interval '30 days'
WHERE "status" = 'candidate' AND "expires_at" IS NULL;--> statement-breakpoint
DROP INDEX "memories_identity";--> statement-breakpoint
CREATE UNIQUE INDEX "memory_relations_identity" ON "memory_relations" USING btree ("guild_id","from_subject_type","from_subject_id","predicate","kind","to_subject_type","to_subject_id",coalesce("isolation_channel_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "memories_identity" ON "memories" USING btree ("guild_id",coalesce("owner_user_id", ''),coalesce("channel_id", ''),coalesce("isolation_channel_id", ''),"subject_type","subject_id","topic","slot") WHERE "memories"."status" = 'active';
