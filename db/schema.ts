// Drizzle schema — Slice 1 tables: season, team, game, teamWeekStats.
// Phase 3b (ADR-0026) adds: drive + play (forward-only, greenfield per ADR-0015;
// empty for 2021–2025, populated 2026 wk1+) and the job_queue ingestion table.
//
// Sections below are pre-staged for the eventual per-domain file split
// (docs/schema-design.md → Drizzle conventions → Schema file organisation).
// When this file crosses ~250 lines or a domain hits a third table, mv this
// file into db/schema/{reference,games,team-stats}.ts and re-export from
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
  jsonb,
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

// Phase 3b jobQueue (ADR-0026 unit-of-work taxonomy; ADR-0016 status lifecycle).
export const jobTypeEnum = pgEnum("job_type", ["ingest_game", "aggregate_week"]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
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
    // Phase 3b gate-passed / freeze-point marker (ADR-0028; records ADR-0019's
    // completeness-gate pass). NULL = not gate-passed; non-null = plays frozen as-of this
    // instant. Set-once, LAST step of ingest_game on gate pass (COALESCE keeps it stable
    // under stall-sweep re-runs). This is filter (ii)'s completeness read for ingest_game —
    // play-presence != gate-passed, so the read keys off this marker, NOT play rows. Dies
    // with the game row on the ADR-0015 cascade-delete, re-exposing the unit to discovery.
    // Distinct from `status` (real-world game state): a game can be `final` with plays
    // incomplete (the write-once hole), so the two are deliberately orthogonal.
    playsFrozenAt: timestamp({ withTimezone: true, mode: "date" }),
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
// PLAY-BY-PLAY (Phase 3b, forward-only — ADR-0015 / ADR-0018 / ADR-0013)
// ============================================================================

// Drives extract to their own table during ingestion and `play.driveId`
// references the parent (ADR-0013 option b). Columns + mappings per
// docs/parquet-mapping.md (drive_* → here); dedup by (game_id, fixed_drive).
export const drive = pgTable(
  "drive",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gameId: bigint({ mode: "number" })
      .notNull()
      .references(() => game.id),
    // fixed_drive — canonical drive number (respects mid-game corrections).
    driveNumber: smallint().notNull(),
    result: text(), // fixed_drive_result
    playCount: smallint(), // drive_play_count
    timeOfPossession: integer(), // drive_time_of_possession → seconds (MM:SS parsed at ingest)
    firstDowns: smallint(), // drive_first_downs
    insideTwenty: boolean(), // drive_inside20 (0/1 → bool)
    endedWithScore: boolean(), // drive_ended_with_score (0/1 → bool)
  },
  (t) => [
    unique("drive_game_id_drive_number_unique").on(t.gameId, t.driveNumber),
  ],
);

// Column set per ADR-0018's inclusion principle (Descriptor + Volatility tests),
// applied via docs/parquet-mapping.md. Player-attribution columns
// (rusher/receiver/passer) are deferred to Slice 4 (no `player` table yet;
// team-level scope per ADR-0015) — ADR-0018's reversible ADD COLUMN backfills
// them then. Reconstructable rollups / derivable companions are excluded.
export const play = pgTable(
  "play",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gameId: bigint({ mode: "number" })
      .notNull()
      .references(() => game.id),
    driveId: bigint({ mode: "number" }).references(() => drive.id),
    // Denormalised season/week (ADR-0018 descriptor set) so aggregate_week's
    // season-to-date scan (ADR-0026) filters here without a join to `game`.
    // seasonId is the resolved FK (uniform with the rest of the schema).
    seasonId: bigint({ mode: "number" })
      .notNull()
      .references(() => season.id),
    week: smallint().notNull(),
    // nflverse play identifier; (game_id, play_id) is the upsert / idempotency
    // key (ADR-0019 write-once / cascade-replay) and serves per-game gate reads.
    playId: integer().notNull(),
    orderSequence: integer(), // nflfastR canonical within-game sort key
    // Resolved team FKs (ADR-0026 decision B): nflverse posteam/defteam
    // abbreviations are resolved to team_id at ingest; unknown abbr = loud fail.
    posteamTeamId: bigint({ mode: "number" }).references(() => team.id),
    defteamTeamId: bigint({ mode: "number" }).references(() => team.id),
    // Participant descriptors (ADR-0018 query-proven). Raw nflverse ids/names as
    // nullable TEXT with NO FK — the `player` table is Slice 4, which adds the FK
    // and resolves text→player_id then (resolved in ADR-0031). Captured now so each
    // write-once row is complete from a single parquet release (ADR-0019), sparing
    // Slice 4 a revisit.
    rusherPlayerId: text(),
    rusherPlayerName: text(),
    receiverPlayerId: text(),
    receiverPlayerName: text(),
    passerPlayerId: text(),
    passerPlayerName: text(),
    // Classification (0/1 → bool). pass|rush is ADR-0020's EPA universe;
    // twoPointAttempt is its exclusion.
    pass: boolean(),
    rush: boolean(),
    passAttempt: boolean(),
    rushAttempt: boolean(),
    completePass: boolean(),
    qbDropback: boolean(),
    qbScramble: boolean(),
    twoPointAttempt: boolean(),
    shotgun: boolean(),
    noHuddle: boolean(),
    qbHit: boolean(),
    isSuccessful: boolean(), // success (= epa>0; stored as ergonomics convenience)
    // Situational descriptors (ADR-0018 Descriptor test, natural breadth).
    down: smallint(),
    yardsToGo: smallint(),
    quarter: smallint(),
    timeRemainingSeconds: integer(), // `time` MM:SS within quarter → seconds
    runLocation: text(),
    runGap: text(),
    passLocation: text(),
    passLength: text(),
    // Yardage. passingYards/rushingYards are the box-score universe (exclude
    // 2pt) summed by teamWeekStats' traditional aggregates (build.py / ADR-0020).
    yardsGained: integer(),
    passingYards: integer(),
    rushingYards: integer(),
    receivingYards: integer(),
    airYards: integer(),
    yardsAfterCatch: integer(),
    // In-game score, possession-team frame (ADR-0013 / parquet-mapping.md).
    scoreOffense: integer(), // posteam_score
    scoreDefense: integer(), // defteam_score
    // Non-reconstructable base model outputs (ADR-0018 Volatility test).
    epa: doublePrecision(),
    airEpa: doublePrecision(),
    wpa: doublePrecision(),
    cpoe: doublePrecision(),
    xpass: doublePrecision(),
    passOverExpected: doublePrecision(), // pass_oe
    expectedPointsBefore: doublePrecision(), // ep
  },
  (t) => [
    // Upsert conflict target; game_id-leading also serves the gate's per-game reads.
    unique("play_game_id_play_id_unique").on(t.gameId, t.playId),
    // aggregate_week season-to-date scan: WHERE season_id = S AND week <= N.
    index("play_season_id_week_idx").on(t.seasonId, t.week),
    index("play_drive_id_idx").on(t.driveId),
  ],
);

// ============================================================================
// INGESTION INFRASTRUCTURE (Phase 3b — ADR-0008 / ADR-0016 / ADR-0026)
// ============================================================================

// Per-type payloads (ADR-0026). The `job_type` COLUMN is the sole discriminant —
// no discriminant is embedded in the jsonb (which can drift from the column).
// The payload is an untyped trust boundary until parsed: at drain, narrow on the
// row's `job_type` and parse the payload against the matching per-type schema
// (runtime validation + compile-time narrowing). ingest_game carries the game to
// ingest; aggregate_week carries the week to close out + its snapshotted count.
export type IngestGamePayload = {
  nflverseGameId: string;
  seasonYear: number;
  week: number;
};
export type AggregateWeekPayload = {
  seasonYear: number;
  week: number;
  expectedGames: number;
};
export type JobPayload = IngestGamePayload | AggregateWeekPayload;

export const jobQueue = pgTable(
  "job_queue",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobType: jobTypeEnum().notNull(),
    payload: jsonb().$type<JobPayload>().notNull(),
    status: jobStatusEnum().notNull().default("pending"),
    notBefore: timestamp({ withTimezone: true, mode: "date" }),
    createdAt: timestamp({ withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // in_progress-since, drives the 15-minute stalled-job sweep (ADR-0016).
    startedAt: timestamp({ withTimezone: true, mode: "date" }),
    retryCount: integer().notNull().default(0),
  },
  (t) => [
    // ADR-0016 drain predicate + ordering; partial clause keeps the index tiny.
    index("job_queue_pending_idx")
      .on(t.notBefore, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
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

export const gameRelations = relations(game, ({ one, many }) => ({
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
  drives: many(drive),
  plays: many(play),
}));

export const driveRelations = relations(drive, ({ one, many }) => ({
  game: one(game, { fields: [drive.gameId], references: [game.id] }),
  plays: many(play),
}));

export const playRelations = relations(play, ({ one }) => ({
  game: one(game, { fields: [play.gameId], references: [game.id] }),
  drive: one(drive, { fields: [play.driveId], references: [drive.id] }),
  season: one(season, { fields: [play.seasonId], references: [season.id] }),
  posteamTeam: one(team, {
    fields: [play.posteamTeamId],
    references: [team.id],
    relationName: "posteamTeam",
  }),
  defteamTeam: one(team, {
    fields: [play.defteamTeamId],
    references: [team.id],
    relationName: "defteamTeam",
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
