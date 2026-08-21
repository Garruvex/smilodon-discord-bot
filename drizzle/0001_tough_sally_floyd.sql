CREATE TABLE "channel_summary_checkpoints" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"last_message_id" text,
	"scan_completed_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_summary_checkpoints_guild_id_channel_id_pk" PRIMARY KEY("guild_id","channel_id")
);
