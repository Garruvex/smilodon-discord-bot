CREATE TABLE "memory_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"from_subject_type" text NOT NULL,
	"from_subject_id" text NOT NULL,
	"predicate" text NOT NULL,
	"to_subject_type" text NOT NULL,
	"to_subject_id" text NOT NULL,
	"isolation_channel_id" text,
	"supporting_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_supporting_memory_id_memories_id_fk" FOREIGN KEY ("supporting_memory_id") REFERENCES "memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_relations_guild_from" ON "memory_relations" USING btree ("guild_id","from_subject_type","from_subject_id");--> statement-breakpoint
CREATE INDEX "memory_relations_guild_to" ON "memory_relations" USING btree ("guild_id","to_subject_type","to_subject_id");