CREATE TABLE "message_cleanup_work" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	CONSTRAINT "message_cleanup_work_guild_id_channel_id_message_id_pk" PRIMARY KEY("guild_id","channel_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "message_revocation_scopes" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "message_revocation_scopes_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "message_revocations" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "message_revocations_guild_id_channel_id_message_id_pk" PRIMARY KEY("guild_id","channel_id","message_id")
);
--> statement-breakpoint
CREATE INDEX "message_cleanup_work_due_idx" ON "message_cleanup_work" USING btree ("state","next_at");