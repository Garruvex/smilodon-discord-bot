CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "birthday_announcements" (
	"guild_id" text NOT NULL,
	"date" text NOT NULL,
	"announced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "birthday_announcements_guild_id_date_pk" PRIMARY KEY("guild_id","date")
);
--> statement-breakpoint
CREATE TABLE "birthdays" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"member_id" uuid,
	"month" integer NOT NULL,
	"day" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "birthdays_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"asserted_by_user_id" text NOT NULL,
	"member_id" uuid,
	"subject_user_id" text NOT NULL,
	"topic" text NOT NULL,
	"slot" text NOT NULL,
	"statement" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"member_id" uuid,
	"exchanges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_guild_id_user_id_channel_id_pk" PRIMARY KEY("guild_id","user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "control_panels" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_notes_preferences" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"member_id" uuid,
	"dm_notes_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_notes_preferences_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "guild_configurations" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"configuration" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_knowledge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"topic" text NOT NULL,
	"slot" text NOT NULL,
	"statement" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"asserted_by_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_by_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1536),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"kind" text NOT NULL,
	"audience" text NOT NULL,
	"owner_user_id" text,
	"channel_id" text,
	"isolation_channel_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"topic" text NOT NULL,
	"slot" text NOT NULL,
	"statement" text NOT NULL,
	"structured_value" jsonb,
	"status" text NOT NULL,
	"superseded_by_id" uuid,
	"source" text NOT NULL,
	"confidence" integer NOT NULL,
	"importance" integer NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_message_id" text,
	"source_channel_id" text,
	"asserted_by_user_id" text,
	"statement" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_customizations" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"member_id" uuid,
	"customization" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_customizations_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "birthdays" ADD CONSTRAINT "birthdays_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_memories" ADD CONSTRAINT "chat_memories_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_notes_preferences" ADD CONSTRAINT "dm_notes_preferences_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_sources_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_customizations" ADD CONSTRAINT "user_customizations_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_memories_owner_subject_topic_slot" ON "chat_memories" USING btree ("guild_id","asserted_by_user_id","subject_user_id","topic","slot");--> statement-breakpoint
CREATE INDEX "chat_memories_embedding_hnsw" ON "chat_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "guild_knowledge_subject_topic_slot" ON "guild_knowledge" USING btree ("guild_id","channel_id","subject_type","subject_id","topic","slot");--> statement-breakpoint
CREATE INDEX "guild_knowledge_embedding_hnsw" ON "guild_knowledge" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "guild_members_guild_user" ON "guild_members" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_identity" ON "memories" USING btree ("guild_id","owner_user_id","channel_id","isolation_channel_id","subject_type","subject_id","topic","slot") WHERE "memories"."status" = 'active';--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_guild_audience_status" ON "memories" USING btree ("guild_id","audience","status");--> statement-breakpoint
CREATE INDEX "memory_sources_memory_id" ON "memory_sources" USING btree ("memory_id");
