CREATE TABLE "birthday_announcements" (
	"guild_id" text NOT NULL,
	"date" text NOT NULL,
	"announced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "birthday_announcements_guild_id_date_pk" PRIMARY KEY("guild_id","date")
);
--> statement-breakpoint
CREATE TABLE "birthdays" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"month" integer NOT NULL,
	"day" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "birthdays_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
