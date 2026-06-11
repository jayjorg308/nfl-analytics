// Drizzle schema — Slice 1 tables: season, team, game, teamWeekStats.
//
// Sections below are pre-staged for the eventual per-domain file split
// (docs/schema-design.md → Drizzle conventions → Schema file organisation).
// When this file crosses ~250 lines or a domain hits a third table, mv this
// file into src/db/schema/{reference,games,team-stats}.ts and re-export from
// schema/index.ts. Call-site imports `from "@/db/schema"` stay unchanged.

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  pgView,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// ============================================================================
// ENUMS
// ============================================================================

export const gameTypeEnum = pgEnum("game_type", [
  "regular",
  "wildcard",
  "divisional",
  "conference",
  "super_bowl",
]);

export const gameStatusEnum = pgEnum("game_status", [
  "scheduled",
  "in_progress",
  "final",
]);

export const conferenceEnum = pgEnum("conference", ["afc", "nfc"]);

export const divisionEnum = pgEnum("division", [
  "afc_east",
  "afc_north",
  "afc_south",
  "afc_west",
  "nfc_east",
  "nfc_north",
  "nfc_south",
  "nfc_west",
]);

// ============================================================================
// REFERENCE DATA
// ============================================================================

export const season = pgTable("season", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  year: smallint().notNull().unique(),
  startDate: date().notNull(),
  endDate: date().notNull(),
});

export const team = pgTable(
  "team",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    abbreviation: text().notNull().unique(),
    conference: conferenceEnum().notNull(),
    division: divisionEnum().notNull(),
  },
  (t) => [
    check("team_abbreviation_format", sql`${t.abbreviation} ~ '^[A-Z]{2,3}$'`),
  ],
);

// ============================================================================
// GAMES
// ============================================================================

export const game = pgTable(
  "game",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: bigint({ mode: "number" })
      .notNull()
      .references(() => season.id),
    week: smallint().notNull(),
    gameType: gameTypeEnum().notNull(),
    homeTeamId: bigint({ mode: "number" })
      .notNull()
      .references(() => team.id),
    awayTeamId: bigint({ mode: "number" })
      .notNull()
      .references(() => team.id),
    gameDateTime: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    isNeutralSite: boolean().notNull().default(false),
    isInternational: boolean().notNull().default(false),
    homeScore: integer(),
    awayScore: integer(),
    status: gameStatusEnum().notNull().default("scheduled"),
    // Weather — null for dome games and unforecast future games.
    temperature: integer(),
    windMph: integer(),
    precipitationChance: integer(),
    weatherCondition: text(),
    // Idempotency keys for ingestion upserts.
    nflverseGameId: text().notNull().unique("game_nflverse_game_id_unique"),
    oddsApiEventId: text(),
  },
  (t) => [
    index("game_season_week_idx").on(t.seasonId, t.week),
    index("game_game_date_time_idx").on(t.gameDateTime),
    index("game_home_team_id_idx").on(t.homeTeamId),
    index("game_away_team_id_idx").on(t.awayTeamId),
  ],
);

// ============================================================================
// TEAM ROLLING STATS
// ============================================================================

export const teamWeekStats = pgTable(
  "team_week_stats",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    teamId: bigint({ mode: "number" })
      .notNull()
      .references(() => team.id),
    seasonId: bigint({ mode: "number" })
      .notNull()
      .references(() => season.id),
    week: smallint().notNull(),
    // Overall EPA (defensive sign convention: ADR-0002).
    overallEpaPerPlay: doublePrecision().notNull(),
    offensiveEpaPerPlay: doublePrecision().notNull(),
    defensiveEpaPerPlay: doublePrecision().notNull(),
    // Phase-specific EPA.
    offensivePassEpaPerPlay: doublePrecision().notNull(),
    offensiveRushEpaPerPlay: doublePrecision().notNull(),
    defensivePassEpaPerPlay: doublePrecision().notNull(),
    defensiveRushEpaPerPlay: doublePrecision().notNull(),
    // ELO (in-house, ADR-0004). Rank within league derived at read time, not stored.
    eloRating: doublePrecision().notNull(),
    eloChange: doublePrecision().notNull(),
    // Strength of schedule.
    sosRank: integer().notNull(),
    // Record.
    recordWins: integer().notNull(),
    recordLosses: integer().notNull(),
    recordTies: integer().notNull(),
    // Traditional offensive aggregates.
    pointsScoredPerGame: doublePrecision().notNull(),
    passYardsPerGame: doublePrecision().notNull(),
    rushYardsPerGame: doublePrecision().notNull(),
    // Traditional defensive aggregates.
    pointsAllowedPerGame: doublePrecision().notNull(),
    passYardsAllowedPerGame: doublePrecision().notNull(),
    rushYardsAllowedPerGame: doublePrecision().notNull(),
  },
  (t) => [
    unique("team_week_stats_team_season_week_unique").on(
      t.teamId,
      t.seasonId,
      t.week,
    ),
    index("team_week_stats_season_id_idx").on(t.seasonId),
  ],
);

// ============================================================================
// RELATIONS
// ============================================================================

export const seasonRelations = relations(season, ({ many }) => ({
  games: many(game),
  teamWeekStats: many(teamWeekStats),
}));

export const teamRelations = relations(team, ({ many }) => ({
  homeGames: many(game, { relationName: "homeTeam" }),
  awayGames: many(game, { relationName: "awayTeam" }),
  teamWeekStats: many(teamWeekStats),
}));

export const gameRelations = relations(game, ({ one }) => ({
  season: one(season, { fields: [game.seasonId], references: [season.id] }),
  homeTeam: one(team, {
    fields: [game.homeTeamId],
    references: [team.id],
    relationName: "homeTeam",
  }),
  awayTeam: one(team, {
    fields: [game.awayTeamId],
    references: [team.id],
    relationName: "awayTeam",
  }),
}));

export const teamWeekStatsRelations = relations(teamWeekStats, ({ one }) => ({
  team: one(team, { fields: [teamWeekStats.teamId], references: [team.id] }),
  season: one(season, {
    fields: [teamWeekStats.seasonId],
    references: [season.id],
  }),
}));

// ============================================================================
// VIEWS
// ============================================================================

// Slate Dashboard read shape. View body lives in raw SQL — see
// drizzle/0001_create_week_summary_view.sql. ADR-0009 establishes the
// view-as-read-shape pattern; ADR-0002 specifies the edge formula.
//
// Column order here MUST match the view body's SELECT order — Drizzle
// only validates types, not ordering. Future additions go at the END of
// both the view body and this declaration (CREATE OR REPLACE VIEW can
// add columns at the end but cannot reorder existing ones).

export type TopEdgeLabel =
  | "home_pass"
  | "home_rush"
  | "away_pass"
  | "away_rush";

export const weekSummary = pgView("week_summary", {
  // Identity & game context
  gameId: bigint({ mode: "number" }).notNull(),
  seasonId: bigint({ mode: "number" }).notNull(),
  week: smallint().notNull(),
  gameType: gameTypeEnum().notNull(),
  gameDateTime: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  isNeutralSite: boolean().notNull(),
  isInternational: boolean().notNull(),
  // Weather (nullable for dome games and unforecast future games)
  temperature: integer(),
  windMph: integer(),
  precipitationChance: integer(),
  weatherCondition: text(),
  // Home team identity & standing
  homeTeamId: bigint({ mode: "number" }).notNull(),
  homeTeamAbbreviation: text().notNull(),
  homeRecordWins: integer().notNull(),
  homeRecordLosses: integer().notNull(),
  homeRecordTies: integer().notNull(),
  homeEloRating: doublePrecision().notNull(),
  homeSosRank: integer().notNull(),
  // Home team EPA
  homeOverallEpaPerPlay: doublePrecision().notNull(),
  homeOffensiveEpaPerPlay: doublePrecision().notNull(),
  homeDefensiveEpaPerPlay: doublePrecision().notNull(),
  homeOffensivePassEpaPerPlay: doublePrecision().notNull(),
  homeOffensiveRushEpaPerPlay: doublePrecision().notNull(),
  homeDefensivePassEpaPerPlay: doublePrecision().notNull(),
  homeDefensiveRushEpaPerPlay: doublePrecision().notNull(),
  // Away team identity & standing
  awayTeamId: bigint({ mode: "number" }).notNull(),
  awayTeamAbbreviation: text().notNull(),
  awayRecordWins: integer().notNull(),
  awayRecordLosses: integer().notNull(),
  awayRecordTies: integer().notNull(),
  awayEloRating: doublePrecision().notNull(),
  awaySosRank: integer().notNull(),
  // Away team EPA
  awayOverallEpaPerPlay: doublePrecision().notNull(),
  awayOffensiveEpaPerPlay: doublePrecision().notNull(),
  awayDefensiveEpaPerPlay: doublePrecision().notNull(),
  awayOffensivePassEpaPerPlay: doublePrecision().notNull(),
  awayOffensiveRushEpaPerPlay: doublePrecision().notNull(),
  awayDefensivePassEpaPerPlay: doublePrecision().notNull(),
  awayDefensiveRushEpaPerPlay: doublePrecision().notNull(),
  // Per-matchup edges
  homePassEdge: doublePrecision().notNull(),
  homeRushEdge: doublePrecision().notNull(),
  awayPassEdge: doublePrecision().notNull(),
  awayRushEdge: doublePrecision().notNull(),
  // Top edge resolution
  topEdgeLabel: text().$type<TopEdgeLabel>().notNull(),
  topEdgeValue: doublePrecision().notNull(),
  topEdgeMagnitude: doublePrecision().notNull(),
}).existing();
