ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
UPDATE "memories" SET "valid_from" = "created_at" WHERE "valid_from" IS NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "valid_from" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "valid_from" SET NOT NULL;
