CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
-- Existing jsonb embeddings are discarded rather than cast (a value written
-- under a previous/different embedding model may not even be 1536-wide) —
-- selectors already treat a null embedding as "rank on lexical score alone,"
-- so this is a safe degrade, not a break. Affected records simply get
-- re-embedded next time they're written.
ALTER TABLE "chat_memories" ALTER COLUMN "embedding" TYPE vector(1536) USING NULL;--> statement-breakpoint
ALTER TABLE "guild_knowledge" ALTER COLUMN "embedding" TYPE vector(1536) USING NULL;--> statement-breakpoint
CREATE INDEX "chat_memories_embedding_hnsw" ON "chat_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "guild_knowledge_embedding_hnsw" ON "guild_knowledge" USING hnsw ("embedding" vector_cosine_ops);
