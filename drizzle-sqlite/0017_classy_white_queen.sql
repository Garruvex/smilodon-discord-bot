CREATE TABLE `message_cleanup_work` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `message_cleanup_work_due_idx` ON `message_cleanup_work` (`state`,`next_at`);--> statement-breakpoint
CREATE TABLE `message_revocation_scopes` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `message_revocations` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`revoked_at` integer NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`, `message_id`)
);
