CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "reminders_due_at" ON "reminders" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "reminders_guild_user" ON "reminders" USING btree ("guild_id","user_id");