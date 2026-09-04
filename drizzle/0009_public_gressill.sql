CREATE TABLE "personal_memory_extraction_jobs" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"display_name" text NOT NULL,
	"content" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_memory_extraction_jobs_guild_id_channel_id_batch_id_subject_id_pk" PRIMARY KEY("guild_id","channel_id","batch_id","subject_id")
);
--> statement-breakpoint
CREATE INDEX "personal_memory_extraction_jobs_due" ON "personal_memory_extraction_jobs" USING btree ("status","next_attempt_at");