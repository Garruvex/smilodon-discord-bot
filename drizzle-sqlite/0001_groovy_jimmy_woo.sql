CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`audience` text NOT NULL,
	`owner_user_id` text,
	`channel_id` text,
	`isolation_channel_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`topic` text NOT NULL,
	`slot` text NOT NULL,
	`statement` text NOT NULL,
	`structured_value` text,
	`status` text NOT NULL,
	`superseded_by_id` text,
	`source` text NOT NULL,
	`confidence` integer NOT NULL,
	`importance` integer NOT NULL,
	`embedding` text,
	`embedding_model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_identity` ON `memories` (`guild_id`,`owner_user_id`,`channel_id`,`isolation_channel_id`,`subject_type`,`subject_id`,`topic`,`slot`) WHERE "memories"."status" = 'active';--> statement-breakpoint
CREATE TABLE `memory_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`source_message_id` text,
	`source_channel_id` text,
	`asserted_by_user_id` text,
	`statement` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
