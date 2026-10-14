DROP INDEX `memories_identity`;--> statement-breakpoint
ALTER TABLE `memories` ADD `module_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `memories_identity` ON `memories` (`guild_id`,coalesce("owner_user_id", ''),coalesce("channel_id", ''),coalesce("isolation_channel_id", ''),coalesce("module_id", ''),`subject_type`,`subject_id`,`topic`,`slot`) WHERE "memories"."status" = 'active';--> statement-breakpoint
ALTER TABLE `conversation_episodes` ADD `retention_ms` integer DEFAULT 900000 NOT NULL;
