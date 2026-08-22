ALTER TABLE `channel_summary_checkpoints` ADD `daily_cursor` text;--> statement-breakpoint
ALTER TABLE `channel_summary_checkpoints` ADD `daily_high_water_mark_at` integer;--> statement-breakpoint
ALTER TABLE `channel_summary_checkpoints` ADD `last_error_code` text;--> statement-breakpoint
ALTER TABLE `channel_summary_checkpoints` ADD `last_success_at` integer;