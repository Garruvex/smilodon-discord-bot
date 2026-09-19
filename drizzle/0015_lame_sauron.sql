CREATE TABLE "message_reaction_watches" (
	"message_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"first_reaction_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_reaction_watches_due" ON "message_reaction_watches" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "message_reaction_watches_cleanup" ON "message_reaction_watches" USING btree ("status","updated_at");