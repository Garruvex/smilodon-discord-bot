ALTER TABLE "channel_summary_checkpoints" ADD COLUMN "daily_cursor" text;--> statement-breakpoint
ALTER TABLE "channel_summary_checkpoints" ADD COLUMN "daily_high_water_mark_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_summary_checkpoints" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "channel_summary_checkpoints" ADD COLUMN "last_success_at" timestamp with time zone;