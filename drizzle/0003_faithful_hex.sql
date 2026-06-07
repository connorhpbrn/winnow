ALTER TABLE "seen_stories" DROP CONSTRAINT "seen_stories_account_id_story_id_pk";--> statement-breakpoint
ALTER TABLE "seen_stories" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "seen_stories" ADD CONSTRAINT "seen_stories_account_id_story_id_revision_pk" PRIMARY KEY("account_id","story_id","revision");--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
