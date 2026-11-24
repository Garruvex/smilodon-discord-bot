CREATE TABLE `provenance_current` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`, `kind`, `artifact_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `provenance_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provenance_edges` (
	`child_id` text NOT NULL,
	`parent_id` text NOT NULL,
	`projection` text NOT NULL,
	`representation_hash` text NOT NULL,
	`assets_hash` text,
	PRIMARY KEY(`child_id`, `parent_id`, `projection`),
	FOREIGN KEY (`child_id`) REFERENCES `provenance_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `provenance_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provenance_edges_parent_idx` ON `provenance_edges` (`parent_id`,`child_id`);--> statement-breakpoint
CREATE TABLE `provenance_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`state` text NOT NULL,
	`completeness` text NOT NULL,
	`purpose` text,
	`audience_user_id` text,
	`output_hash` text,
	`attachment_hash` text,
	`author_id` text,
	`source_timestamp_ms` integer,
	`representation_hash` text,
	`subject_id` text,
	`owner_id` text,
	`asserter_id` text,
	`lineage` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provenance_revisions_version_idx` ON `provenance_revisions` (`guild_id`,`channel_id`,`kind`,`artifact_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `provenance_revisions_ordinal_idx` ON `provenance_revisions` (`guild_id`,`channel_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `provenance_revisions_author_idx` ON `provenance_revisions` (`guild_id`,`author_id`);--> statement-breakpoint
CREATE INDEX `provenance_revisions_subject_idx` ON `provenance_revisions` (`guild_id`,`subject_id`);--> statement-breakpoint
CREATE INDEX `provenance_revisions_owner_idx` ON `provenance_revisions` (`guild_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX `provenance_revisions_asserter_idx` ON `provenance_revisions` (`guild_id`,`asserter_id`);--> statement-breakpoint
ALTER TABLE `message_revocation_scopes` ADD `ordinal` integer DEFAULT 0 NOT NULL;