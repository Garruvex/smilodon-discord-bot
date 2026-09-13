CREATE TABLE "member_boost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"member_id" uuid,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_boost_events" ADD CONSTRAINT "member_boost_events_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_boost_events_guild_user" ON "member_boost_events" USING btree ("guild_id","user_id");