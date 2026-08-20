ALTER TABLE "chat_sessions" ADD COLUMN "channel_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_guild_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_guild_id_user_id_channel_id_pk" PRIMARY KEY("guild_id","user_id","channel_id");
