-- Hand-written: drizzle-kit's SQLite generator quotes index expressions as
-- if they were column names, and the data fix-ups below must run before the
-- (now effective) unique indexes are created. See the Postgres counterpart
-- (drizzle/0017_memory_identity_indexes.sql) for what each step is for.
UPDATE `memories` SET `status` = 'superseded', `superseded_by_id` = `ranked`.`keep_id`,
  `valid_until` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM (
  SELECT `id`,
    first_value(`id`) OVER `w` AS `keep_id`,
    row_number() OVER `w` AS `rn`
  FROM `memories`
  WHERE `status` = 'active'
  WINDOW `w` AS (
    PARTITION BY `guild_id`, coalesce(`owner_user_id`, ''), coalesce(`channel_id`, ''), coalesce(`isolation_channel_id`, ''),
      `subject_type`, `subject_id`, `topic`, `slot`
    ORDER BY `updated_at` DESC, `id` DESC
  )
) AS `ranked`
WHERE `memories`.`id` = `ranked`.`id` AND `ranked`.`rn` > 1;--> statement-breakpoint
DELETE FROM `memory_relations` WHERE `id` IN (
  SELECT `id` FROM (
    SELECT `id`, row_number() OVER (
      PARTITION BY `guild_id`, `from_subject_type`, `from_subject_id`, `predicate`, `kind`,
        `to_subject_type`, `to_subject_id`, coalesce(`isolation_channel_id`, '')
      ORDER BY `created_at`, `id`
    ) AS `rn` FROM `memory_relations`
  ) WHERE `rn` > 1
);--> statement-breakpoint
UPDATE `memories` SET `expires_at` = `created_at` + 2592000000
WHERE `status` = 'candidate' AND `expires_at` IS NULL;--> statement-breakpoint
DROP INDEX `memories_identity`;--> statement-breakpoint
CREATE UNIQUE INDEX `memories_identity` ON `memories` (`guild_id`,coalesce(`owner_user_id`, ''),coalesce(`channel_id`, ''),coalesce(`isolation_channel_id`, ''),`subject_type`,`subject_id`,`topic`,`slot`) WHERE "memories"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `memory_relations_identity` ON `memory_relations` (`guild_id`,`from_subject_type`,`from_subject_id`,`predicate`,`kind`,`to_subject_type`,`to_subject_id`,coalesce(`isolation_channel_id`, ''));
