CREATE TABLE `message_reaction_watches` (
	`message_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text DEFAULT 'watching' NOT NULL,
	`first_reaction_at` integer,
	`due_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_reaction_watches_due` ON `message_reaction_watches` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `message_reaction_watches_cleanup` ON `message_reaction_watches` (`status`,`updated_at`);