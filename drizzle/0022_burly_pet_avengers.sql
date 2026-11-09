DROP INDEX "memories_identity";--> statement-breakpoint
ALTER TABLE "conversation_episodes" ADD COLUMN "retention_ms" integer DEFAULT 900000 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "module_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_identity" ON "memories" USING btree ("guild_id",coalesce("owner_user_id", ''),coalesce("channel_id", ''),coalesce("isolation_channel_id", ''),coalesce("module_id", ''),"subject_type","subject_id","topic","slot") WHERE "memories"."status" = 'active';