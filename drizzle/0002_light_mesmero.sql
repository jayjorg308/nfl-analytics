CREATE TYPE "public"."job_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('ingest_game', 'aggregate_week');--> statement-breakpoint
CREATE TABLE "drive" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"game_id" bigint NOT NULL,
	"drive_number" smallint NOT NULL,
	"result" text,
	"play_count" smallint,
	"time_of_possession" integer,
	"first_downs" smallint,
	"inside_twenty" boolean,
	"ended_with_score" boolean,
	CONSTRAINT "drive_game_id_drive_number_unique" UNIQUE("game_id","drive_number")
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_type" "job_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"not_before" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"game_id" bigint NOT NULL,
	"drive_id" bigint,
	"season_id" bigint NOT NULL,
	"week" smallint NOT NULL,
	"play_id" integer NOT NULL,
	"order_sequence" integer,
	"posteam_team_id" bigint,
	"defteam_team_id" bigint,
	"rusher_player_id" text,
	"rusher_player_name" text,
	"receiver_player_id" text,
	"receiver_player_name" text,
	"passer_player_id" text,
	"passer_player_name" text,
	"pass" boolean,
	"rush" boolean,
	"pass_attempt" boolean,
	"rush_attempt" boolean,
	"complete_pass" boolean,
	"qb_dropback" boolean,
	"qb_scramble" boolean,
	"two_point_attempt" boolean,
	"shotgun" boolean,
	"no_huddle" boolean,
	"qb_hit" boolean,
	"is_successful" boolean,
	"down" smallint,
	"yards_to_go" smallint,
	"quarter" smallint,
	"time_remaining_seconds" integer,
	"run_location" text,
	"run_gap" text,
	"pass_location" text,
	"pass_length" text,
	"yards_gained" integer,
	"passing_yards" integer,
	"rushing_yards" integer,
	"receiving_yards" integer,
	"air_yards" integer,
	"yards_after_catch" integer,
	"score_offense" integer,
	"score_defense" integer,
	"epa" double precision,
	"air_epa" double precision,
	"wpa" double precision,
	"cpoe" double precision,
	"xpass" double precision,
	"pass_over_expected" double precision,
	"expected_points_before" double precision,
	CONSTRAINT "play_game_id_play_id_unique" UNIQUE("game_id","play_id")
);
--> statement-breakpoint
ALTER TABLE "drive" ADD CONSTRAINT "drive_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play" ADD CONSTRAINT "play_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play" ADD CONSTRAINT "play_drive_id_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "public"."drive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play" ADD CONSTRAINT "play_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play" ADD CONSTRAINT "play_posteam_team_id_team_id_fk" FOREIGN KEY ("posteam_team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play" ADD CONSTRAINT "play_defteam_team_id_team_id_fk" FOREIGN KEY ("defteam_team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_queue_pending_idx" ON "job_queue" USING btree ("not_before","created_at") WHERE "job_queue"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "play_season_id_week_idx" ON "play" USING btree ("season_id","week");--> statement-breakpoint
CREATE INDEX "play_drive_id_idx" ON "play" USING btree ("drive_id");