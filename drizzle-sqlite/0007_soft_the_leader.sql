CREATE TABLE `personal_memory_extraction_jobs` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`display_name` text NOT NULL,
	`content` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`, `batch_id`, `subject_id`)
);
--> statement-breakpoint
CREATE INDEX `personal_memory_extraction_jobs_due` ON `personal_memory_extraction_jobs` (`status`,`next_attempt_at`);