CREATE TABLE `conversation_episodes` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `memory_forget_cutoffs` (
	`guild_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`topic` text NOT NULL,
	`slot` text NOT NULL,
	`scope_key` text NOT NULL,
	`cutoff` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `subject_id`, `topic`, `slot`, `scope_key`)
);
--> statement-breakpoint
CREATE TABLE `memory_observed_aliases` (
	`guild_id` text NOT NULL,
	`alias` text NOT NULL,
	`memory_id` text NOT NULL,
	PRIMARY KEY(`memory_id`, `alias`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_observed_aliases_lookup` ON `memory_observed_aliases` (`guild_id`,`alias`);--> statement-breakpoint
CREATE TABLE `message_origins` (
	`message_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`origin` text NOT NULL,
	`source_message_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_origins_scope_idx` ON `message_origins` (`guild_id`,`channel_id`);--> statement-breakpoint
ALTER TABLE `memory_sources` ADD `source_timestamp` integer;--> statement-breakpoint
ALTER TABLE `memory_sources` ADD `source_quote` text;--> statement-breakpoint
ALTER TABLE `memory_sources` ADD `source_channel_mode` text;--> statement-breakpoint
ALTER TABLE `personal_memory_extraction_jobs` ADD `source_messages` text DEFAULT '[]' NOT NULL;