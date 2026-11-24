CREATE TABLE "provenance_current" (
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"artifact_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "provenance_current_guild_id_channel_id_kind_artifact_id_pk" PRIMARY KEY("guild_id","channel_id","kind","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "provenance_edges" (
	"child_id" text NOT NULL,
	"parent_id" text NOT NULL,
	"projection" text NOT NULL,
	"representation_hash" text NOT NULL,
	"assets_hash" text,
	CONSTRAINT "provenance_edges_child_id_parent_id_projection_pk" PRIMARY KEY("child_id","parent_id","projection")
);
--> statement-breakpoint
CREATE TABLE "provenance_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"ordinal" bigint NOT NULL,
	"state" text NOT NULL,
	"completeness" text NOT NULL,
	"purpose" text,
	"audience_user_id" text,
	"output_hash" text,
	"attachment_hash" text,
	"author_id" text,
	"source_timestamp_ms" bigint,
	"representation_hash" text,
	"subject_id" text,
	"owner_id" text,
	"asserter_id" text,
	"lineage" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_revocation_scopes" ADD COLUMN "ordinal" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provenance_current" ADD CONSTRAINT "provenance_current_revision_id_provenance_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "provenance_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_edges" ADD CONSTRAINT "provenance_edges_child_id_provenance_revisions_id_fk" FOREIGN KEY ("child_id") REFERENCES "provenance_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance_edges" ADD CONSTRAINT "provenance_edges_parent_id_provenance_revisions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "provenance_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provenance_edges_parent_idx" ON "provenance_edges" USING btree ("parent_id","child_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provenance_revisions_version_idx" ON "provenance_revisions" USING btree ("guild_id","channel_id","kind","artifact_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "provenance_revisions_ordinal_idx" ON "provenance_revisions" USING btree ("guild_id","channel_id","ordinal");--> statement-breakpoint
CREATE INDEX "provenance_revisions_author_idx" ON "provenance_revisions" USING btree ("guild_id","author_id");--> statement-breakpoint
CREATE INDEX "provenance_revisions_subject_idx" ON "provenance_revisions" USING btree ("guild_id","subject_id");--> statement-breakpoint
CREATE INDEX "provenance_revisions_owner_idx" ON "provenance_revisions" USING btree ("guild_id","owner_id");--> statement-breakpoint
CREATE INDEX "provenance_revisions_asserter_idx" ON "provenance_revisions" USING btree ("guild_id","asserter_id");