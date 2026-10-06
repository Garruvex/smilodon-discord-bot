CREATE TABLE "campaign_adventures" (
	"entry_key" text PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "campaign_adventures_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"status" text NOT NULL,
	"adventure" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_campaigns" (
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"revision" integer NOT NULL,
	"state" json NOT NULL,
	"ruleset" json NOT NULL,
	"adventure" json NOT NULL,
	CONSTRAINT "campaign_campaigns_guild_id_campaign_id_pk" PRIMARY KEY("guild_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_events" (
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"envelope" json NOT NULL,
	CONSTRAINT "campaign_events_guild_id_campaign_id_sequence_pk" PRIMARY KEY("guild_id","campaign_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "campaign_guild_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "campaign_guild_settings_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"settings" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_library_characters" (
	"id" text PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "campaign_library_characters_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_user_id" text NOT NULL,
	"character" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_library_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"revision" integer NOT NULL,
	"source_key" text NOT NULL,
	"snapshot" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "campaign_outbox_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"kind" text NOT NULL,
	"request" json NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"last_error" text,
	"not_before" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_processed_commands" (
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"command_id" text NOT NULL,
	"outcome" json NOT NULL,
	CONSTRAINT "campaign_processed_commands_guild_id_campaign_id_command_id_pk" PRIMARY KEY("guild_id","campaign_id","command_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_records" (
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "campaign_records_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"revision" integer NOT NULL,
	"lifecycle" text NOT NULL,
	"record" json NOT NULL,
	CONSTRAINT "campaign_records_guild_id_campaign_id_pk" PRIMARY KEY("guild_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_rolls" (
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"roll_id" text NOT NULL,
	"result" json NOT NULL,
	"rolled_at" bigint NOT NULL,
	CONSTRAINT "campaign_rolls_guild_id_campaign_id_roll_id_pk" PRIMARY KEY("guild_id","campaign_id","roll_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_timers" (
	"guild_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"timer_id" text NOT NULL,
	"position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "campaign_timers_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"due_at" bigint NOT NULL,
	"timer" json NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "campaign_timers_guild_id_campaign_id_timer_id_pk" PRIMARY KEY("guild_id","campaign_id","timer_id")
);
--> statement-breakpoint
CREATE INDEX "campaign_adventures_by_guild" ON "campaign_adventures" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "campaign_library_characters_by_owner" ON "campaign_library_characters" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_library_snapshots_by_source" ON "campaign_library_snapshots" USING btree ("character_id","source_key");--> statement-breakpoint
CREATE INDEX "campaign_library_snapshots_by_character" ON "campaign_library_snapshots" USING btree ("character_id","revision");--> statement-breakpoint
CREATE INDEX "campaign_outbox_pending" ON "campaign_outbox" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "campaign_records_by_guild" ON "campaign_records" USING btree ("guild_id","lifecycle");--> statement-breakpoint
CREATE INDEX "campaign_timers_due" ON "campaign_timers" USING btree ("status","due_at");