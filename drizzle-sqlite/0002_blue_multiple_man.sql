CREATE TABLE `channel_summary_checkpoints` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`last_message_id` text,
	`scan_completed_at` integer,
	`last_run_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`)
);
