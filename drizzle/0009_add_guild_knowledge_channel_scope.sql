DROP INDEX "guild_knowledge_subject_topic_slot";--> statement-breakpoint
ALTER TABLE "guild_knowledge" ADD COLUMN "channel_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_knowledge_subject_topic_slot" ON "guild_knowledge" USING btree ("guild_id","channel_id","subject_type","subject_id","topic","slot");