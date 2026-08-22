CREATE TABLE `chat_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`asserted_by_user_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`topic` text NOT NULL,
	`slot` text NOT NULL,
	`statement` text NOT NULL,
	`embedding` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_memories_owner_subject_topic_slot` ON `chat_memories` (`guild_id`,`asserted_by_user_id`,`subject_user_id`,`topic`,`slot`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`exchanges` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `dm_notes_preferences` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`dm_notes_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `guild_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`topic` text NOT NULL,
	`slot` text NOT NULL,
	`statement` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`asserted_by_user_ids` text DEFAULT '[]' NOT NULL,
	`confirmed_by_user_ids` text DEFAULT '[]' NOT NULL,
	`embedding` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guild_knowledge_subject_topic_slot` ON `guild_knowledge` (`guild_id`,`channel_id`,`subject_type`,`subject_id`,`topic`,`slot`);