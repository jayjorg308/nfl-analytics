// Game-scoped play-by-play reader (the ingest_game handler's input — next chunk).
//
// v1 LEAN (ADR-0026 deferral / ADR-0029): pull the SEASON pbp parquet (column-filtered)
// and filter rows to one game_id IN MEMORY. Row-GROUP predicate pushdown on game_id is
// the deferred optimization (unconfirmed the parquet's row-group ordering would even let
// it skip groups) — revisit only if the 300s drain budget tightens. Structured so
// pushdown can slot in behind `readGamePlays` without reshaping callers.
//
// SCOPE: this reader PARSES ONLY. Rows carry raw nflverse team ABBREVIATIONS; it does
// NOT resolve them to team_id and does NOT write to the DB. Abbr→team_id resolution
// (exact-match, loud-fail) and persistence belong to the ingest_game handler.
//
// nodejs runtime only.

import { asBool, asInt, asNum, asStr, mmssToSeconds } from "./parse";
import { pbpReleaseUrl, readReleaseParquet } from "./nflverse";

// Projection over the pbp parquet (docs/parquet-mapping.md). Confirmed present in the
// nflverse pbp release; keeping the fetch narrow matters at ~20MB/season.
const PBP_COLUMNS = [
  // identity / refs (abbreviations — unresolved here)
  "game_id", "season", "week", "posteam", "defteam", "play_id", "order_sequence",
  // drive context (fixed_drive is canonical, NOT the raw `drive`)
  "fixed_drive", "fixed_drive_result", "drive_play_count", "drive_time_of_possession",
  "drive_first_downs", "drive_inside20", "drive_ended_with_score",
  // participants (raw text, no FK — Slice 4 resolves to player_id)
  "rusher_player_id", "rusher_player_name", "receiver_player_id", "receiver_player_name",
  "passer_player_id", "passer_player_name",
  // classification flags (DOUBLE 0/1 → bool)
  "pass", "rush", "pass_attempt", "rush_attempt", "complete_pass", "qb_dropback",
  "qb_scramble", "two_point_attempt", "shotgun", "no_huddle", "qb_hit", "success",
  // situational
  "down", "ydstogo", "qtr", "time", "run_location", "run_gap", "pass_location", "pass_length",
  // yardage
  "yards_gained", "passing_yards", "rushing_yards", "receiving_yards", "air_yards",
  "yards_after_catch",
  // score state — the three representations kept distinct (ADR-0013)
  "posteam_score", "defteam_score", // possession-frame → play.scoreOffense/scoreDefense
  "home_score", "away_score", // FINAL (replicated every row) — gate reconciliation input
  "total_home_score", "total_away_score", // in-game at the play
  // base model outputs (ADR-0018 Volatility test)
  "epa", "air_epa", "wpa", "cpoe", "xpass", "pass_oe", "ep",
  // scoring-result columns — GATE reconciliation ONLY (not persisted to `play`).
  // Attribution validated against all 272 2025 REG games (exact match).
  "touchdown", "td_team", "field_goal_result", "extra_point_result",
  "two_point_conv_result", "safety", "defensive_two_point_conv",
];

/** One parsed pbp row. Team fields are raw nflverse ABBREVIATIONS (unresolved). */
export type RawPlay = {
  // identity / refs
  gameId: string;
  season: number;
  week: number;
  posteam: string | null;
  defteam: string | null;
  playId: number | null;
  orderSequence: number | null;
  // drive context
  fixedDrive: number | null;
  driveResult: string | null;
  drivePlayCount: number | null;
  driveTimeOfPossession: number | null; // seconds
  driveFirstDowns: number | null;
  driveInside20: boolean | null;
  driveEndedWithScore: boolean | null;
  // participants
  rusherPlayerId: string | null;
  rusherPlayerName: string | null;
  receiverPlayerId: string | null;
  receiverPlayerName: string | null;
  passerPlayerId: string | null;
  passerPlayerName: string | null;
  // classification
  pass: boolean | null;
  rush: boolean | null;
  passAttempt: boolean | null;
  rushAttempt: boolean | null;
  completePass: boolean | null;
  qbDropback: boolean | null;
  qbScramble: boolean | null;
  twoPointAttempt: boolean | null;
  shotgun: boolean | null;
  noHuddle: boolean | null;
  qbHit: boolean | null;
  isSuccessful: boolean | null;
  // situational
  down: number | null;
  yardsToGo: number | null;
  quarter: number | null;
  timeRemainingSeconds: number | null;
  runLocation: string | null;
  runGap: string | null;
  passLocation: string | null;
  passLength: string | null;
  // yardage
  yardsGained: number | null;
  passingYards: number | null;
  rushingYards: number | null;
  receivingYards: number | null;
  airYards: number | null;
  yardsAfterCatch: number | null;
  // score — three distinct representations
  scoreOffense: number | null; // posteam_score
  scoreDefense: number | null; // defteam_score
  finalHomeScore: number | null; // home_score (replicated final)
  finalAwayScore: number | null; // away_score (replicated final)
  inGameHomeScore: number | null; // total_home_score
  inGameAwayScore: number | null; // total_away_score
  // base model
  epa: number | null;
  airEpa: number | null;
  wpa: number | null;
  cpoe: number | null;
  xpass: number | null;
  passOverExpected: number | null; // pass_oe
  expectedPointsBefore: number | null; // ep
  // scoring-result fields — completeness-gate reconciliation ONLY; the writer does
  // not persist these (the `play` table has no scoring-result columns).
  touchdown: boolean | null;
  tdTeam: string | null; // abbreviation of the scoring team (offense OR defense)
  fieldGoalResult: string | null; // 'made' | 'missed' | 'blocked'
  extraPointResult: string | null; // 'good' | 'failed' | 'blocked' | 'aborted' | 'safety'
  twoPointConvResult: string | null; // 'success' | 'failure'
  safety: boolean | null;
  defensiveTwoPointConv: boolean | null;
};

/** One deduplicated drive (per ADR-0013: dedup by fixed_drive). */
export type RawDrive = {
  driveNumber: number; // fixed_drive
  result: string | null;
  playCount: number | null;
  timeOfPossession: number | null; // seconds
  firstDowns: number | null;
  insideTwenty: boolean | null;
  endedWithScore: boolean | null;
};

function parsePlay(r: Record<string, unknown>): RawPlay {
  return {
    gameId: String(r.game_id),
    season: Number(r.season),
    week: Number(r.week),
    posteam: asStr(r.posteam),
    defteam: asStr(r.defteam),
    playId: asInt(r.play_id),
    orderSequence: asInt(r.order_sequence),
    fixedDrive: asInt(r.fixed_drive),
    driveResult: asStr(r.fixed_drive_result),
    drivePlayCount: asInt(r.drive_play_count),
    driveTimeOfPossession: mmssToSeconds(r.drive_time_of_possession),
    driveFirstDowns: asInt(r.drive_first_downs),
    driveInside20: asBool(r.drive_inside20),
    driveEndedWithScore: asBool(r.drive_ended_with_score),
    rusherPlayerId: asStr(r.rusher_player_id),
    rusherPlayerName: asStr(r.rusher_player_name),
    receiverPlayerId: asStr(r.receiver_player_id),
    receiverPlayerName: asStr(r.receiver_player_name),
    passerPlayerId: asStr(r.passer_player_id),
    passerPlayerName: asStr(r.passer_player_name),
    pass: asBool(r.pass),
    rush: asBool(r.rush),
    passAttempt: asBool(r.pass_attempt),
    rushAttempt: asBool(r.rush_attempt),
    completePass: asBool(r.complete_pass),
    qbDropback: asBool(r.qb_dropback),
    qbScramble: asBool(r.qb_scramble),
    twoPointAttempt: asBool(r.two_point_attempt),
    shotgun: asBool(r.shotgun),
    noHuddle: asBool(r.no_huddle),
    qbHit: asBool(r.qb_hit),
    isSuccessful: asBool(r.success),
    down: asInt(r.down),
    yardsToGo: asInt(r.ydstogo),
    quarter: asInt(r.qtr),
    timeRemainingSeconds: mmssToSeconds(r.time),
    runLocation: asStr(r.run_location),
    runGap: asStr(r.run_gap),
    passLocation: asStr(r.pass_location),
    passLength: asStr(r.pass_length),
    yardsGained: asInt(r.yards_gained),
    passingYards: asInt(r.passing_yards),
    rushingYards: asInt(r.rushing_yards),
    receivingYards: asInt(r.receiving_yards),
    airYards: asInt(r.air_yards),
    yardsAfterCatch: asInt(r.yards_after_catch),
    scoreOffense: asInt(r.posteam_score),
    scoreDefense: asInt(r.defteam_score),
    finalHomeScore: asInt(r.home_score),
    finalAwayScore: asInt(r.away_score),
    inGameHomeScore: asInt(r.total_home_score),
    inGameAwayScore: asInt(r.total_away_score),
    epa: asNum(r.epa),
    airEpa: asNum(r.air_epa),
    wpa: asNum(r.wpa),
    cpoe: asNum(r.cpoe),
    xpass: asNum(r.xpass),
    passOverExpected: asNum(r.pass_oe),
    expectedPointsBefore: asNum(r.ep),
    touchdown: asBool(r.touchdown),
    tdTeam: asStr(r.td_team),
    fieldGoalResult: asStr(r.field_goal_result),
    extraPointResult: asStr(r.extra_point_result),
    twoPointConvResult: asStr(r.two_point_conv_result),
    safety: asBool(r.safety),
    defensiveTwoPointConv: asBool(r.defensive_two_point_conv),
  };
}

/**
 * Read + parse one game's plays from the season pbp release (v1 lean: whole-season
 * pull, in-memory filter to `nflverseGameId`). Rows carry raw abbreviations.
 */
export async function readGamePlays(
  seasonYear: number,
  nflverseGameId: string,
): Promise<RawPlay[]> {
  const rows = await readReleaseParquet(pbpReleaseUrl(seasonYear), PBP_COLUMNS);
  return rows
    .filter((r) => String(r.game_id) === nflverseGameId)
    .map(parsePlay);
}

/**
 * Pure transform: dedup a game's plays into its drives by `fixedDrive` (ADR-0013).
 * First occurrence wins (drive context is replicated identically across the drive's
 * plays). Plays with a null `fixedDrive` (e.g. timeouts) contribute no drive.
 */
export function extractDrives(plays: RawPlay[]): RawDrive[] {
  const byDrive = new Map<number, RawDrive>();
  for (const p of plays) {
    if (p.fixedDrive == null || byDrive.has(p.fixedDrive)) continue;
    byDrive.set(p.fixedDrive, {
      driveNumber: p.fixedDrive,
      result: p.driveResult,
      playCount: p.drivePlayCount,
      timeOfPossession: p.driveTimeOfPossession,
      firstDowns: p.driveFirstDowns,
      insideTwenty: p.driveInside20,
      endedWithScore: p.driveEndedWithScore,
    });
  }
  return [...byDrive.values()].sort((a, b) => a.driveNumber - b.driveNumber);
}
