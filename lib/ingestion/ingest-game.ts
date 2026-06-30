// Phase 3b ingest_game handler (ADR-0028 §1 sequence; ADR-0019 completeness gate;
// ADR-0027 (A) idempotency-by-construction). Builds ONE game's game/drive/play rows
// from the schedule + pbp, runs the completeness gate, and on pass sets the
// playsFrozenAt marker LAST.
//
// SCOPE: the handler FUNCTION only. Job-status transitions, retry/backoff, and
// FOR UPDATE SKIP LOCKED are the DRAIN's concern (a later chunk) — not here.
//
// TRANSACTION STRUCTURE (the deep form of trap #2): the game+drives+plays bulk write
// COMMITS independently of the gate verdict; playsFrozenAt is a SEPARATE final UPDATE
// on pass only. The bulk write is NOT wrapped with the gate in a roll-back-on-fail
// transaction — the marker exists precisely because partial plays CAN be committed for
// a gate-failed game (play-presence != gate-passed, ADR-0028 §1). A re-run upserts the
// delta idempotently (conflict-tolerant writes) and re-gates.
//
// nodejs runtime only.

import { eq, getTableColumns, sql, type SQL } from "drizzle-orm";

import type { Db } from "@/db";
import { drive, game, play, season, team, type IngestGamePayload } from "@/db/schema";

import {
  deriveIsInternational,
  deriveIsNeutralSite,
  fetchSchedule,
  homeStadiumModalMap,
  type ScheduledGame,
} from "./schedule";
import { extractDrives, readGamePlays, type RawDrive, type RawPlay } from "./pbp";

// --- completeness gate (ADR-0019) ---

/** Distinguishable from infrastructure errors so the drain backoff can retry the gate. */
export class CompletenessGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletenessGateError";
  }
}

// ADR-0019 thresholds. PLAY_COUNT_FLOOR catches gross truncation and is the TUNABLE one
// (revisit on the first live 2026 week).
export const PLAY_COUNT_FLOOR = 100;

// SCORE_RECONCILIATION_TOLERANCE must STAY 0 (exact) permanently — it is NOT a tuning knob.
// The reconciliation's whole job is to prove scoring plays are PRESENT, and a missing extra
// point is the most common real 1-point gap; any tolerance >= 1 would mask exactly that,
// defeating the invariant. A rare scoring type that surfaces on a live week is fixed by
// EXTENDING sumScoringPoints' attribution (add the case), NEVER by widening this tolerance.
// (Reconciled exact across all 272 2025 REG games.)
export const SCORE_RECONCILIATION_TOLERANCE = 0;

/**
 * Sum each team's points from the SCORING PLAYS THEMSELVES (proving they are present),
 * not from the replicated final score. Attribution validated exact against all 272
 * 2025 REG games: TD→td_team +6 (offense or defense), XP good +1 / FG made +3 / 2pt
 * success +2 to posteam, safety +2 / defensive-2pt +2 to defteam.
 */
function sumScoringPoints(
  plays: RawPlay[],
  homeAbbr: string,
  awayAbbr: string,
): { home: number; away: number } {
  const pts: Record<string, number> = { [homeAbbr]: 0, [awayAbbr]: 0 };
  const add = (teamAbbr: string | null, n: number) => {
    if (teamAbbr != null && teamAbbr in pts) pts[teamAbbr] += n;
  };
  for (const p of plays) {
    if (p.touchdown) add(p.tdTeam, 6);
    if (p.extraPointResult === "good") add(p.posteam, 1);
    if (p.fieldGoalResult === "made") add(p.posteam, 3);
    if (p.twoPointConvResult === "success") add(p.posteam, 2);
    if (p.safety) add(p.defteam, 2);
    if (p.defensiveTwoPointConv) add(p.defteam, 2);
  }
  return { home: pts[homeAbbr], away: pts[awayAbbr] };
}

/**
 * Run the per-game completeness gate against the written plays (ADR-0019). Throws
 * CompletenessGateError on any failure; the caller leaves the committed plays in place
 * and does NOT set the marker.
 */
export function runCompletenessGate(
  plays: RawPlay[],
  scheduled: ScheduledGame,
): void {
  const finalHome = scheduled.homeScore;
  const finalAway = scheduled.awayScore;
  if (finalHome == null || finalAway == null) {
    // Belt-and-braces: step 2 already asserted score-present.
    throw new CompletenessGateError(`${scheduled.nflverseGameId}: final score missing at gate`);
  }
  // Secondary: every final game has plays + a gross-truncation floor.
  if (plays.length === 0) {
    throw new CompletenessGateError(`${scheduled.nflverseGameId}: no plays present`);
  }
  if (plays.length < PLAY_COUNT_FLOOR) {
    throw new CompletenessGateError(
      `${scheduled.nflverseGameId}: ${plays.length} plays < floor ${PLAY_COUNT_FLOOR}`,
    );
  }
  // Primary: scoring-play reconciliation against the game-row final score.
  const { home, away } = sumScoringPoints(plays, scheduled.homeAbbr, scheduled.awayAbbr);
  if (
    Math.abs(home - finalHome) > SCORE_RECONCILIATION_TOLERANCE ||
    Math.abs(away - finalAway) > SCORE_RECONCILIATION_TOLERANCE
  ) {
    throw new CompletenessGateError(
      `${scheduled.nflverseGameId}: scoring plays do not reconstruct final ` +
        `(derived ${away}@${home} vs final ${finalAway}@${finalHome}) — plays missing`,
    );
  }
}

// --- team resolution (exact-match, loud-fail — trap #8) ---

type TeamMap = Map<string, number>;

async function loadTeamMap(db: Db): Promise<TeamMap> {
  const rows = await db.select({ id: team.id, abbreviation: team.abbreviation }).from(team);
  return new Map(rows.map((r) => [r.abbreviation, r.id]));
}

/** Required resolution: an unknown abbreviation is a loud failure (no alias map). */
export function resolveTeam(map: TeamMap, abbr: string): number {
  const id = map.get(abbr);
  if (id === undefined) throw new Error(`Unknown team abbreviation: ${abbr}`);
  return id;
}

/** Nullable resolution: a null abbr (e.g. a no-possession play) resolves to null; a
 *  present-but-unknown abbr still loud-fails. */
function resolveTeamNullable(map: TeamMap, abbr: string | null): number | null {
  return abbr == null ? null : resolveTeam(map, abbr);
}

// --- conflict-tolerant upsert helper (ADR-0027 (A)) ---

// camelCase TS key → the snake_case DB column name (the schema relies on the drizzle
// `casing: "snake_case"` config; all play/drive columns are unnamed, so the DB name is
// exactly snake_case(key)). Used for the `excluded.<col>` references below.
function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// Build an ON CONFLICT DO UPDATE `set` mapping every column except those excluded to
// `excluded.<col>` — so a later, more-complete parquet corrects in place (ADR-0019).
function excludedSet(
  table: typeof drive | typeof play,
  exclude: string[],
): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(getTableColumns(table))) {
    if (exclude.includes(key)) continue;
    set[key] = sql.raw(`excluded.${snakeCase(key)}`);
  }
  return set;
}

// --- the handler ---

export type IngestGameResult = {
  nflverseGameId: string;
  gameId: number;
  driveCount: number;
  playCount: number;
  frozenAt: Date;
};

export async function ingestGame(
  db: Db,
  payload: IngestGamePayload,
): Promise<IngestGameResult> {
  const { nflverseGameId, seasonYear, week } = payload;

  // 1. Resolve this game's schedule row (v1 re-fetches per job; the drain may hoist it).
  const schedule = await fetchSchedule(seasonYear);
  const scheduled = schedule.find((g) => g.nflverseGameId === nflverseGameId);
  if (!scheduled) {
    throw new Error(`Schedule has no game ${nflverseGameId} in season ${seasonYear}`);
  }

  // 2. ASSERT score-present on entry. A scoreless game is a discovery-contract breach
  //    (discovery only enqueues scored games) — loud-fail, never wait/poll (trap #3).
  if (scheduled.homeScore == null || scheduled.awayScore == null) {
    throw new Error(
      `ingest_game contract breach: ${nflverseGameId} has no final score (discovery should not have enqueued it)`,
    );
  }

  // 3. Read this game's plays (raw abbreviations).
  const plays = await readGamePlays(seasonYear, nflverseGameId);

  // 4. Resolve abbreviations → team_id (exact-match, loud-fail). Home/away on the game
  //    row AND posteam/defteam on every play.
  const teamMap = await loadTeamMap(db);
  const homeTeamId = resolveTeam(teamMap, scheduled.homeAbbr);
  const awayTeamId = resolveTeam(teamMap, scheduled.awayAbbr);

  // Game-row metadata derived the SAME way Phase 3a did (trap #9): status=final (scored),
  // gameType already mapped (schedule.ts), modal-derived neutral/international, weather
  // left null (Phase 3a's build.py wrote no weather), gameDateTime = the ET→UTC kickoff.
  const modal = homeStadiumModalMap(schedule);
  const isNeutralSite = deriveIsNeutralSite(scheduled, modal);
  const isInternational = deriveIsInternational(scheduled, modal);

  const seasonRow = await db
    .select({ id: season.id })
    .from(season)
    .where(eq(season.year, seasonYear));
  const seasonId = seasonRow[0]?.id;
  if (seasonId === undefined) {
    throw new Error(`No season row for year ${seasonYear} — seed the season first`);
  }

  // 5. Extract drives (dedup by fixed_drive).
  const drives = extractDrives(plays);

  // 6. Write game + drives + plays — one transaction, conflict-tolerant upserts.
  //    COMMITS independently of the gate (trap #2). Marker is NOT written here.
  let gameId = 0;
  await db.transaction(async (tx) => {
    const upserted = await tx
      .insert(game)
      .values({
        seasonId,
        week,
        gameType: scheduled.gameType,
        homeTeamId,
        awayTeamId,
        gameDateTime: scheduled.kickoff,
        isNeutralSite,
        isInternational,
        homeScore: scheduled.homeScore,
        awayScore: scheduled.awayScore,
        status: "final",
        nflverseGameId,
      })
      .onConflictDoUpdate({
        target: game.nflverseGameId,
        // Refresh metadata on re-pull; NEVER touch playsFrozenAt here (set as step 8).
        set: {
          seasonId,
          week,
          gameType: scheduled.gameType,
          homeTeamId,
          awayTeamId,
          gameDateTime: scheduled.kickoff,
          isNeutralSite,
          isInternational,
          homeScore: scheduled.homeScore,
          awayScore: scheduled.awayScore,
          status: "final",
        },
      })
      .returning({ id: game.id });
    gameId = upserted[0].id;

    if (drives.length > 0) {
      await tx
        .insert(drive)
        .values(drives.map((d) => toDriveValues(d, gameId)))
        .onConflictDoUpdate({
          target: [drive.gameId, drive.driveNumber],
          set: excludedSet(drive, ["id", "gameId", "driveNumber"]),
        });
    }

    // Map fixed_drive → drive.id to wire play.driveId.
    const driveRows = await tx
      .select({ id: drive.id, driveNumber: drive.driveNumber })
      .from(drive)
      .where(eq(drive.gameId, gameId));
    const driveIdByNumber = new Map(driveRows.map((r) => [r.driveNumber, r.id]));

    const playValues = plays.map((p) =>
      toPlayValues(p, gameId, seasonId, driveIdByNumber, teamMap),
    );
    if (playValues.length > 0) {
      await tx
        .insert(play)
        .values(playValues)
        .onConflictDoUpdate({
          target: [play.gameId, play.playId],
          set: excludedSet(play, ["id", "gameId", "playId"]),
        });
    }
  });

  // 7. Completeness gate against the written plays. On FAIL: throw, leave plays
  //    committed, do NOT set the marker (the drain retries; re-run upserts the delta).
  runCompletenessGate(plays, scheduled);

  // 8. PASS only — set the marker LAST, idempotently (trap #2). COALESCE keeps the
  //    original freeze-time stable under a stall-sweep / retry re-run.
  const frozen = await db
    .update(game)
    .set({ playsFrozenAt: sql`COALESCE(${game.playsFrozenAt}, now())` })
    .where(eq(game.nflverseGameId, nflverseGameId))
    .returning({ frozenAt: game.playsFrozenAt });

  return {
    nflverseGameId,
    gameId,
    driveCount: drives.length,
    playCount: plays.length,
    frozenAt: frozen[0].frozenAt!,
  };
}

// --- row mappers ---

function toDriveValues(d: RawDrive, gameId: number) {
  return {
    gameId,
    driveNumber: d.driveNumber,
    result: d.result,
    playCount: d.playCount,
    timeOfPossession: d.timeOfPossession,
    firstDowns: d.firstDowns,
    insideTwenty: d.insideTwenty,
    endedWithScore: d.endedWithScore,
  };
}

function toPlayValues(
  p: RawPlay,
  gameId: number,
  seasonId: number,
  driveIdByNumber: Map<number, number>,
  teamMap: TeamMap,
) {
  if (p.playId == null) {
    throw new Error(`Play with null play_id in game ${p.gameId} — cannot key the upsert`);
  }
  return {
    gameId,
    driveId: p.fixedDrive == null ? null : (driveIdByNumber.get(p.fixedDrive) ?? null),
    seasonId,
    week: p.week,
    playId: p.playId,
    orderSequence: p.orderSequence,
    posteamTeamId: resolveTeamNullable(teamMap, p.posteam),
    defteamTeamId: resolveTeamNullable(teamMap, p.defteam),
    rusherPlayerId: p.rusherPlayerId,
    rusherPlayerName: p.rusherPlayerName,
    receiverPlayerId: p.receiverPlayerId,
    receiverPlayerName: p.receiverPlayerName,
    passerPlayerId: p.passerPlayerId,
    passerPlayerName: p.passerPlayerName,
    pass: p.pass,
    rush: p.rush,
    passAttempt: p.passAttempt,
    rushAttempt: p.rushAttempt,
    completePass: p.completePass,
    qbDropback: p.qbDropback,
    qbScramble: p.qbScramble,
    twoPointAttempt: p.twoPointAttempt,
    shotgun: p.shotgun,
    noHuddle: p.noHuddle,
    qbHit: p.qbHit,
    isSuccessful: p.isSuccessful,
    down: p.down,
    yardsToGo: p.yardsToGo,
    quarter: p.quarter,
    timeRemainingSeconds: p.timeRemainingSeconds,
    runLocation: p.runLocation,
    runGap: p.runGap,
    passLocation: p.passLocation,
    passLength: p.passLength,
    yardsGained: p.yardsGained,
    passingYards: p.passingYards,
    rushingYards: p.rushingYards,
    receivingYards: p.receivingYards,
    airYards: p.airYards,
    yardsAfterCatch: p.yardsAfterCatch,
    scoreOffense: p.scoreOffense,
    scoreDefense: p.scoreDefense,
    epa: p.epa,
    airEpa: p.airEpa,
    wpa: p.wpa,
    cpoe: p.cpoe,
    xpass: p.xpass,
    passOverExpected: p.passOverExpected,
    expectedPointsBefore: p.expectedPointsBefore,
  };
}
