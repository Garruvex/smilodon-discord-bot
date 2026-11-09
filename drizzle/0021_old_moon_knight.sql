CREATE TABLE "conversation_episodes" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_episodes_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "memory_forget_cutoffs" (
	"guild_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"topic" text NOT NULL,
	"slot" text NOT NULL,
	"scope_key" text NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_forget_cutoffs_guild_id_subject_id_topic_slot_scope_key_pk" PRIMARY KEY("guild_id","subject_id","topic","slot","scope_key")
);
--> statement-breakpoint
CREATE TABLE "memory_observed_aliases" (
	"guild_id" text NOT NULL,
	"alias" text NOT NULL,
	"memory_id" uuid NOT NULL,
	CONSTRAINT "memory_observed_aliases_memory_id_alias_pk" PRIMARY KEY("memory_id","alias")
);
--> statement-breakpoint
CREATE TABLE "message_origins" (
	"message_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"origin" text NOT NULL,
	"source_message_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "source_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "source_quote" text;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "source_channel_mode" text;--> statement-breakpoint
ALTER TABLE "personal_memory_extraction_jobs" ADD COLUMN "source_messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_observed_aliases" ADD CONSTRAINT "memory_observed_aliases_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_observed_aliases_lookup" ON "memory_observed_aliases" USING btree ("guild_id","alias");--> statement-breakpoint
CREATE INDEX "message_origins_scope_idx" ON "message_origins" USING btree ("guild_id","channel_id");
