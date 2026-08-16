CREATE TABLE "chat_sessions" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"exchanges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"asserted_by_user_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"topic" text NOT NULL,
	"slot" text NOT NULL,
	"statement" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_memories_owner_subject_topic_slot" ON "chat_memories" USING btree ("guild_id","asserted_by_user_id","subject_user_id","topic","slot");
--> statement-breakpoint
CREATE TABLE "guild_knowledge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"topic" text NOT NULL,
	"slot" text NOT NULL,
	"statement" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"asserted_by_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_by_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guild_knowledge_subject_topic_slot" ON "guild_knowledge" USING btree ("guild_id","subject_type","subject_id","topic","slot");
