CREATE TABLE "dm_notes_preferences" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"member_id" uuid,
	"dm_notes_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_notes_preferences_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "dm_notes_preferences" ADD CONSTRAINT "dm_notes_preferences_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "dm_notes_preferences" ("guild_id", "user_id", "member_id", "dm_notes_enabled", "updated_at")
SELECT DISTINCT ON ("guild_id", "user_id") "guild_id", "user_id", "member_id", "dm_notes_enabled", "updated_at"
FROM "chat_sessions"
ORDER BY "guild_id", "user_id", "updated_at" DESC
ON CONFLICT ("guild_id", "user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "dm_notes_enabled";--> statement-breakpoint
-- Pre-channel-scoping session rows carry no real channel — per the chosen
-- "reset" migration behavior, they're dropped outright rather than kept
-- alive under a sentinel channel_id. Their dm_notes_enabled value was
-- already preserved into dm_notes_preferences above.
DELETE FROM "chat_sessions" WHERE "channel_id" = '';