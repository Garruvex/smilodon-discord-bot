CREATE TABLE "guild_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "birthdays" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_memories" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "user_customizations" ADD COLUMN "member_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_members_guild_user" ON "guild_members" USING btree ("guild_id","user_id");--> statement-breakpoint
ALTER TABLE "birthdays" ADD CONSTRAINT "birthdays_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_memories" ADD CONSTRAINT "chat_memories_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."guild_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_customizations" ADD CONSTRAINT "user_customizations_member_id_guild_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."guild_members"("id") ON DELETE cascade ON UPDATE no action;