CREATE TYPE "public"."conference" AS ENUM('afc', 'nfc');--> statement-breakpoint
CREATE TYPE "public"."division" AS ENUM('afc_east', 'afc_north', 'afc_south', 'afc_west', 'nfc_east', 'nfc_north', 'nfc_south', 'nfc_west');--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('scheduled', 'in_progress', 'final');--> statement-breakpoint
CREATE TYPE "public"."game_type" AS ENUM('regular', 'wildcard', 'divisional', 'conference', 'super_bowl');--> statement-breakpoint
CREATE TABLE "game" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" bigint NOT NULL,
	"week" smallint NOT NULL,
	"game_type" "game_type" NOT NULL,
	"home_team_id" bigint NOT NULL,
	"away_team_id" bigint NOT NULL,
	"game_date_time" timestamp with time zone NOT NULL,
	"is_neutral_site" boolean DEFAULT false NOT NULL,
	"is_international" boolean DEFAULT false NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"status" "game_status" DEFAULT 'scheduled' NOT NULL,
	"temperature" integer,
	"wind_mph" integer,
	"precipitation_chance" integer,
	"weather_condition" text,
	"nflverse_game_id" text NOT NULL,
	"odds_api_event_id" text,
	CONSTRAINT "game_nflverse_game_id_unique" UNIQUE("nflverse_game_id")
);
--> statement-breakpoint
CREATE TABLE "season" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"year" smallint NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	CONSTRAINT "season_year_unique" UNIQUE("year")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"abbreviation" text NOT NULL,
	"conference" "conference" NOT NULL,
	"division" "division" NOT NULL,
	CONSTRAINT "team_abbreviation_unique" UNIQUE("abbreviation"),
	CONSTRAINT "team_abbreviation_format" CHECK ("team"."abbreviation" ~ '^[A-Z]{2,3}$')
);
--> statement-breakpoint
CREATE TABLE "team_week_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"team_id" bigint NOT NULL,
	"season_id" bigint NOT NULL,
	"week" smallint NOT NULL,
	"overall_epa_per_play" double precision NOT NULL,
	"offensive_epa_per_play" double precision NOT NULL,
	"defensive_epa_per_play" double precision NOT NULL,
	"offensive_pass_epa_per_play" double precision NOT NULL,
	"offensive_rush_epa_per_play" double precision NOT NULL,
	"defensive_pass_epa_per_play" double precision NOT NULL,
	"defensive_rush_epa_per_play" double precision NOT NULL,
	"elo_rating" double precision NOT NULL,
	"elo_change" double precision NOT NULL,
	"sos_rank" integer NOT NULL,
	"record_wins" integer NOT NULL,
	"record_losses" integer NOT NULL,
	"record_ties" integer NOT NULL,
	"points_scored_per_game" double precision NOT NULL,
	"pass_yards_per_game" double precision NOT NULL,
	"rush_yards_per_game" double precision NOT NULL,
	"points_allowed_per_game" double precision NOT NULL,
	"pass_yards_allowed_per_game" double precision NOT NULL,
	"rush_yards_allowed_per_game" double precision NOT NULL,
	CONSTRAINT "team_week_stats_team_season_week_unique" UNIQUE("team_id","season_id","week")
);
--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_home_team_id_team_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_away_team_id_team_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_week_stats" ADD CONSTRAINT "team_week_stats_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_week_stats" ADD CONSTRAINT "team_week_stats_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_season_week_idx" ON "game" USING btree ("season_id","week");--> statement-breakpoint
CREATE INDEX "game_game_date_time_idx" ON "game" USING btree ("game_date_time");--> statement-breakpoint
CREATE INDEX "game_home_team_id_idx" ON "game" USING btree ("home_team_id");--> statement-breakpoint
CREATE INDEX "game_away_team_id_idx" ON "game" USING btree ("away_team_id");--> statement-breakpoint
CREATE INDEX "team_week_stats_season_id_idx" ON "team_week_stats" USING btree ("season_id");