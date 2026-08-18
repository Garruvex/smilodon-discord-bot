CREATE TABLE "user_customizations" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"customization" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_customizations_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
