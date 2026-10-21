DROP INDEX `memory_relations_identity`;--> statement-breakpoint
ALTER TABLE `memory_relations` ADD `channel_id` text;--> statement-breakpoint
ALTER TABLE `memory_relations` ADD `context_provenance` text;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_relations_identity` ON `memory_relations` (`guild_id`,`from_subject_type`,`from_subject_id`,`predicate`,`kind`,`to_subject_type`,`to_subject_id`,coalesce(`isolation_channel_id`, ''),coalesce(`channel_id`, ''));