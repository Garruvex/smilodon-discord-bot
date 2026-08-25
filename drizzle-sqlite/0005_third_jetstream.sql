CREATE TABLE `memory_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`from_subject_type` text NOT NULL,
	`from_subject_id` text NOT NULL,
	`predicate` text NOT NULL,
	`to_subject_type` text NOT NULL,
	`to_subject_id` text NOT NULL,
	`isolation_channel_id` text,
	`supporting_memory_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`supporting_memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memory_relations_guild_from` ON `memory_relations` (`guild_id`,`from_subject_type`,`from_subject_id`);--> statement-breakpoint
CREATE INDEX `memory_relations_guild_to` ON `memory_relations` (`guild_id`,`to_subject_type`,`to_subject_id`);