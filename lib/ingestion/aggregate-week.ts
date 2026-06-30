// Phase 3b aggregate_week handler (ADR-0026 / ADR-0021 / ADR-0023; reproduces Phase 3a's
// elo.py / build.py / sos.py exactly so the forward chain continues the 2026 wk-0 baseline).
//
// SCOPE: the handler FUNCTION only. Drain/retry/status is the next chunk.
//
// The two load-bearing traps:
//   #1 record — prior-week record + THIS week's result (NEVER read-own-and-increment): the
//      one non-idempotent realization. A stall-sweep/retry re-run must not double-count.
//   #6 cumulative columns — RECOMPUTE season-to-date from play/game every week (teamWeekStats
//      stores means/rates, not running sums) + single-transaction write with a row-count
//      assertion (discovery's bare-existence read, ADR-0028 §2, needs a week never half-written).
//
// nodejs runtime only.

import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";

import type { Db } from "@/db";
import { game, season, team, teamWeekStats, type AggregateWeekPayload } from "@/db/schema";

import { fetchSchedule } from "./schedule";

// --- ELO (reproduced from elo.py — K, HFA, MOV multiplier, tie short-circuit) ---

const BASE_ELO = 1500;
const K = 20;
const HFA = 50;

function expectedHome(homeGameElo: number, awayGameElo: number): number {
  return 1 / (1 + 10 ** ((awayGameElo - homeGameElo) / 400));
}

function movMultiplier(margin: number, winnerEloDiff: number): number {
  return (Math.log(Math.abs(margin) + 1) * 2.2) / (winnerEloDiff * 0.001 + 2.2);
}

/** One game's ELO update (elo.py update_game). Inputs are pre-game ratings. */
export function updateGame(
  homeElo: number,
  awayElo: number,
  homeScore: number,
  awayScore: number,
  neutral: boolean,
): { newHome: number; newAway: number } {
  const hfa = neutral ? 0 : HFA;
  const homeGame = homeElo + hfa;
  const awayGame = awayElo;
  const expH = expectedHome(homeGame, awayGame);
  const expA = 1 - expH;

  let sH: number;
  let sA: number;
  let mult: number;
  if (homeScore > awayScore) {
    sH = 1; sA = 0;
    mult = movMultiplier(homeScore - awayScore, homeGame - awayGame);
  } else if (awayScore > homeScore) {
    sH = 0; sA = 1;
    mult = movMultiplier(awayScore - homeScore, awayGame - homeGame);
  } else {
    sH = 0.5; sA = 0.5; mult = 1; // tie short-circuit (ADR-0022)
  }
  return {
    newHome: homeElo + K * mult * (sH - expH),
    newAway: awayElo + K * mult * (sA - expA),
  };
}

/** Win/loss/tie advance for one played game (build.py compute_record, incrementally). */
export function advanceRecord(
  prior: { wins: number; losses: number; ties: number },
  teamScore: number,
  oppScore: number,
): { wins: number; losses: number; ties: number } {
  return {
    wins: prior.wins + (teamScore > oppScore ? 1 : 0),
    losses: prior.losses + (teamScore < oppScore ? 1 : 0),
    ties: prior.ties + (teamScore === oppScore ? 1 : 0),
  };
}

export type WeekGame = {
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
  isNeutralSite: boolean;
};

type TeamEloRecord = {
  eloRating: number;
  eloChange: number;
  wins: number;
  losses: number;
  ties: number;
};

/**
 * Advance ELO + record over the row set (trap #1). Played teams get the MOV-ELO update and
 * prior-record + this-week's-result; teams in the set that did NOT play (byes) carry forward
 * (eloChange 0, record unchanged). This is `prior + result`, NEVER read-own-and-increment —
 * so a re-run over the same prior + games is identical (idempotent). Pure + exported for test.
 */
export function advanceEloAndRecord(
  weekGames: WeekGame[],
  prior: Map<number, PriorRow>,
  rowTeamIds: Set<number>,
): Map<number, TeamEloRecord> {
  const out = new Map<number, TeamEloRecord>();
  const played = new Set<number>();
  for (const g of weekGames) {
    const ph = prior.get(g.homeTeamId);
    const pa = prior.get(g.awayTeamId);
    if (!ph || !pa) throw new Error("advanceEloAndRecord: team missing from prior week (broken chain)");
    const { newHome, newAway } = updateGame(ph.eloRating, pa.eloRating, g.homeScore, g.awayScore, g.isNeutralSite);
    const hr = advanceRecord(ph, g.homeScore, g.awayScore);
    const ar = advanceRecord(pa, g.awayScore, g.homeScore);
    out.set(g.homeTeamId, { eloRating: newHome, eloChange: newHome - ph.eloRating, ...hr });
    out.set(g.awayTeamId, { eloRating: newAway, eloChange: newAway - pa.eloRating, ...ar });
    played.add(g.homeTeamId);
    played.add(g.awayTeamId);
  }
  for (const teamId of rowTeamIds) {
    if (played.has(teamId)) continue;
    const p = prior.get(teamId);
    if (!p) throw new Error(`advanceEloAndRecord: carry-forward team ${teamId} missing from prior week`);
    out.set(teamId, { eloRating: p.eloRating, eloChange: 0, wins: p.wins, losses: p.losses, ties: p.ties });
  }
  return out;
}

// --- handler ---

const REGULAR_ROW_COUNT = 32;
const PLAYOFF_ROW_COUNT: Record<number, number> = { 19: 14, 20: 8, 21: 4, 22: 2 };

type Rates = {
  overallEpaPerPlay: number;
  offensiveEpaPerPlay: number;
  defensiveEpaPerPlay: number;
  offensivePassEpaPerPlay: number;
  offensiveRushEpaPerPlay: number;
  defensivePassEpaPerPlay: number;
  defensiveRushEpaPerPlay: number;
  sosRank: number;
  pointsScoredPerGame: number;
  passYardsPerGame: number;
  rushYardsPerGame: number;
  pointsAllowedPerGame: number;
  passYardsAllowedPerGame: number;
  rushYardsAllowedPerGame: number;
};

type PriorRow = { eloRating: number; wins: number; losses: number; ties: number };

export type AggregateWeekResult = {
  seasonYear: number;
  week: number;
  rowCount: number;
};

export async function aggregateWeek(
  db: Db,
  payload: AggregateWeekPayload,
): Promise<AggregateWeekResult> {
  const { seasonYear, week, expectedGames } = payload;
  const isPlayoff = week >= 19;
  const expectedRowCount = isPlayoff ? PLAYOFF_ROW_COUNT[week] : REGULAR_ROW_COUNT;
  if (expectedRowCount === undefined) {
    throw new Error(`aggregate_week: unsupported week ${week}`);
  }

  const seasonRow = await db
    .select({ id: season.id })
    .from(season)
    .where(eq(season.year, seasonYear));
  const seasonId = seasonRow[0]?.id;
  if (seasonId === undefined) {
    throw new Error(`aggregate_week: no season row for ${seasonYear}`);
  }

  // 1. ASSERT the precondition (trap #3): all of W's scheduled games are frozen. A shortfall
  //    means a mid-flight cascade un-froze a game — loud-fail, never wait.
  const frozen = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(game)
    .where(
      and(eq(game.seasonId, seasonId), eq(game.week, week), sql`${game.playsFrozenAt} IS NOT NULL`),
    );
  const frozenCount = frozen[0].n;
  if (frozenCount !== expectedGames) {
    throw new Error(
      `aggregate_week ${seasonYear} wk${week}: ${frozenCount} frozen games != expected ${expectedGames} (mid-flight cascade?)`,
    );
  }

  // 2. Read the PRIOR week's rows (ELO + record input). Loud-fail if missing (broken chain).
  const priorRows = await db
    .select({
      teamId: teamWeekStats.teamId,
      eloRating: teamWeekStats.eloRating,
      wins: teamWeekStats.recordWins,
      losses: teamWeekStats.recordLosses,
      ties: teamWeekStats.recordTies,
    })
    .from(teamWeekStats)
    .where(and(eq(teamWeekStats.seasonId, seasonId), eq(teamWeekStats.week, week - 1)));
  if (priorRows.length === 0) {
    throw new Error(`aggregate_week ${seasonYear} wk${week}: prior week ${week - 1} missing (broken chain)`);
  }
  const prior = new Map<number, PriorRow>(
    priorRows.map((r) => [r.teamId, { eloRating: r.eloRating, wins: r.wins, losses: r.losses, ties: r.ties }]),
  );

  // 3. This week's games (ELO/record/this-week) + all season-to-date games (SOS/points).
  const allGames = await db
    .select({
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      week: game.week,
      isNeutralSite: game.isNeutralSite,
    })
    .from(game)
    .where(
      and(
        eq(game.seasonId, seasonId),
        sql`${game.week} BETWEEN 1 AND ${week}`,
        sql`${game.homeScore} IS NOT NULL`,
      ),
    );
  const weekGames: WeekGame[] = allGames
    .filter((g) => g.week === week)
    .map((g) => ({
      homeTeamId: g.homeTeamId,
      awayTeamId: g.awayTeamId,
      homeScore: g.homeScore!,
      awayScore: g.awayScore!,
      isNeutralSite: g.isNeutralSite,
    }));

  const teams = await db.select({ id: team.id, abbreviation: team.abbreviation }).from(team);
  const abbrById = new Map(teams.map((t) => [t.id, t.abbreviation]));
  const idByAbbr = new Map(teams.map((t) => [t.abbreviation, t.id]));

  // Which teams played this week (drives the playoff row-set + bye carry).
  const played = new Set<number>();
  for (const g of weekGames) {
    played.add(g.homeTeamId);
    played.add(g.awayTeamId);
  }

  // 5. Carry-forward row SET (ADR-0021, trap #6): regular → all 32; playoff → played + (wk19)
  //    the #1-seed byes only (eliminated teams absent).
  const rowTeamIds = await resolveRowSet(seasonYear, week, isPlayoff, played, prior, idByAbbr);

  // 4a. ELO + record advance over the row set (trap #1: prior + result, played updated, bye carried).
  const eloRecord = advanceEloAndRecord(weekGames, prior, rowTeamIds);

  // 4b. Rate columns (EPA, traditional, sosRank): regular → recompute season-to-date from
  //     source; playoff → FROZEN at week-18 (ADR-0021).
  const rates = isPlayoff
    ? await frozenRatesFromWeek18(db, seasonId, rowTeamIds)
    : await recomputeRates(db, seasonId, week, allGames, prior, abbrById, rowTeamIds);

  // 6. Assemble + SINGLE-transaction write with the row-count assertion BEFORE commit.
  const rows = [...rowTeamIds].map((teamId) => {
    const r = rates.get(teamId);
    if (!r) throw new Error(`aggregate_week: missing rates for team ${teamId}`);
    const er = eloRecord.get(teamId)!;
    return {
      teamId,
      seasonId,
      week,
      ...r,
      eloRating: er.eloRating,
      eloChange: er.eloChange,
      recordWins: er.wins,
      recordLosses: er.losses,
      recordTies: er.ties,
    };
  });

  if (rows.length !== expectedRowCount) {
    throw new Error(
      `aggregate_week ${seasonYear} wk${week}: assembled ${rows.length} rows != expected ${expectedRowCount}`,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(teamWeekStats)
      .values(rows)
      .onConflictDoUpdate({
        target: [teamWeekStats.teamId, teamWeekStats.seasonId, teamWeekStats.week],
        set: buildExcludedSet(),
      });
  });

  return { seasonYear, week, rowCount: rows.length };
}

// --- row-set resolution (ADR-0021) ---

async function resolveRowSet(
  seasonYear: number,
  week: number,
  isPlayoff: boolean,
  played: Set<number>,
  prior: Map<number, PriorRow>,
  idByAbbr: Map<string, number>,
): Promise<Set<number>> {
  if (!isPlayoff) {
    // Regular week → all 32 (played updated, bye carried).
    return new Set(prior.keys());
  }
  const set = new Set(played);
  if (week === 19) {
    // Wild-card #1-seed byes = teams in the DIVISIONAL (week 20) slate minus WC participants
    // (build.py: played[20] - played[19]). Read week 20 from the schedule — the divisional
    // matchups are set once WC completes.
    //
    // ⚠️ PRE-REGISTERED LIVE-CHECK (ADR-0026 / ADR-0028), UNVALIDATED THIS CHUNK: this depends
    // on the divisional slate being published by week-19 aggregation time. The integration
    // test covers the regular path (week 1) only; the playoff path follows build.py but has
    // no 2026 postseason to validate against yet.
    const schedule = await fetchSchedule(seasonYear);
    for (const g of schedule.filter((s) => s.week === 20)) {
      const home = idByAbbr.get(g.homeAbbr);
      const away = idByAbbr.get(g.awayAbbr);
      if (home !== undefined && !played.has(home)) set.add(home);
      if (away !== undefined && !played.has(away)) set.add(away);
    }
  }
  return set;
}

// --- rate recompute (regular weeks) ---

async function recomputeRates(
  db: Db,
  seasonId: number,
  week: number,
  allGames: { homeTeamId: number; awayTeamId: number; homeScore: number | null; awayScore: number | null; week: number }[],
  prior: Map<number, PriorRow>,
  abbrById: Map<number, string>,
  rowTeamIds: Set<number>,
): Promise<Map<number, Rates>> {
  // EPA pooled means (ADR-0020): scrimmage pass|rush, epa not-null, exclude 2pt; defensive
  // sign is offense-perspective (no flip). avg over zero rows → null → 0.
  const epaSql = (teamCol: "posteam_team_id" | "defteam_team_id") => sql`
    SELECT ${sql.raw(teamCol)} AS team,
      avg(epa) AS all_epa,
      avg(epa) FILTER (WHERE pass) AS pass_epa,
      avg(epa) FILTER (WHERE rush) AS rush_epa
    FROM play
    WHERE season_id = ${seasonId} AND week BETWEEN 1 AND ${week}
      AND (pass OR rush) AND epa IS NOT NULL AND COALESCE(two_point_attempt, false) = false
      AND ${sql.raw(teamCol)} IS NOT NULL
    GROUP BY ${sql.raw(teamCol)}`;
  const offEpa = epaMap((await db.execute(epaSql("posteam_team_id"))).rows);
  const defEpa = epaMap((await db.execute(epaSql("defteam_team_id"))).rows);

  // Traditional yards: sum passing_yards/rushing_yards over ALL plays (build.py compute_traditional),
  // by posteam (for) and defteam (against).
  const yardSql = (teamCol: "posteam_team_id" | "defteam_team_id") => sql`
    SELECT ${sql.raw(teamCol)} AS team,
      sum(passing_yards) AS pass_y, sum(rushing_yards) AS rush_y
    FROM play
    WHERE season_id = ${seasonId} AND week BETWEEN 1 AND ${week} AND ${sql.raw(teamCol)} IS NOT NULL
    GROUP BY ${sql.raw(teamCol)}`;
  const forYards = yardMap((await db.execute(yardSql("posteam_team_id"))).rows);
  const againstYards = yardMap((await db.execute(yardSql("defteam_team_id"))).rows);

  // Points + games-played (build.py compute_traditional: points from final scores), and the
  // realized-SOS accumulation (opp pre-game ELO = opp eloRating at the game's week-1).
  const eloByWeek = await loadEloByWeek(db, seasonId, week - 1);
  const points = new Map<number, { pf: number; pa: number; games: number }>();
  const sos = new Map<number, { sum: number; n: number }>();
  const bump = (m: Map<number, { sum: number; n: number }>, t: number, v: number) => {
    const e = m.get(t) ?? { sum: 0, n: 0 };
    e.sum += v; e.n += 1; m.set(t, e);
  };
  const addPts = (t: number, pf: number, pa: number) => {
    const e = points.get(t) ?? { pf: 0, pa: 0, games: 0 };
    e.pf += pf; e.pa += pa; e.games += 1; points.set(t, e);
  };
  for (const g of allGames) {
    addPts(g.homeTeamId, g.homeScore!, g.awayScore!);
    addPts(g.awayTeamId, g.awayScore!, g.homeScore!);
    const priorWeekElo = eloByWeek.get(g.week - 1);
    if (priorWeekElo) {
      const homeOpp = priorWeekElo.get(g.awayTeamId);
      const awayOpp = priorWeekElo.get(g.homeTeamId);
      if (homeOpp !== undefined) bump(sos, g.homeTeamId, homeOpp);
      if (awayOpp !== undefined) bump(sos, g.awayTeamId, awayOpp);
    }
  }

  // Realized sosRank: 1 = hardest (highest avg opp ELO); tie-break abbreviation asc (sos.py).
  const avgOpp = new Map<number, number>();
  for (const teamId of rowTeamIds) {
    const s = sos.get(teamId);
    avgOpp.set(teamId, s && s.n > 0 ? s.sum / s.n : 0);
  }
  const ranked = [...rowTeamIds].sort((a, b) => {
    const d = avgOpp.get(b)! - avgOpp.get(a)!;
    if (d !== 0) return d;
    return (abbrById.get(a) ?? "") < (abbrById.get(b) ?? "") ? -1 : 1;
  });
  const sosRank = new Map<number, number>();
  ranked.forEach((teamId, i) => sosRank.set(teamId, i + 1));

  const perGame = (n: number, games: number) => (games > 0 ? n / games : 0);
  const rates = new Map<number, Rates>();
  for (const teamId of rowTeamIds) {
    const off = offEpa.get(teamId) ?? { all: 0, pass: 0, rush: 0 };
    const def = defEpa.get(teamId) ?? { all: 0, pass: 0, rush: 0 };
    const fy = forYards.get(teamId) ?? { pass: 0, rush: 0 };
    const ay = againstYards.get(teamId) ?? { pass: 0, rush: 0 };
    const pt = points.get(teamId) ?? { pf: 0, pa: 0, games: 0 };
    rates.set(teamId, {
      offensiveEpaPerPlay: off.all,
      offensivePassEpaPerPlay: off.pass,
      offensiveRushEpaPerPlay: off.rush,
      defensiveEpaPerPlay: def.all,
      defensivePassEpaPerPlay: def.pass,
      defensiveRushEpaPerPlay: def.rush,
      overallEpaPerPlay: (off.all - def.all) / 2,
      sosRank: sosRank.get(teamId)!,
      pointsScoredPerGame: perGame(pt.pf, pt.games),
      pointsAllowedPerGame: perGame(pt.pa, pt.games),
      passYardsPerGame: perGame(fy.pass, pt.games),
      rushYardsPerGame: perGame(fy.rush, pt.games),
      passYardsAllowedPerGame: perGame(ay.pass, pt.games),
      rushYardsAllowedPerGame: perGame(ay.rush, pt.games),
    });
  }
  return rates;
}

// --- rate freeze (playoff weeks) ---

async function frozenRatesFromWeek18(
  db: Db,
  seasonId: number,
  rowTeamIds: Set<number>,
): Promise<Map<number, Rates>> {
  const rows = await db
    .select()
    .from(teamWeekStats)
    .where(and(eq(teamWeekStats.seasonId, seasonId), eq(teamWeekStats.week, 18)));
  const byTeam = new Map(rows.map((r) => [r.teamId, r]));
  const rates = new Map<number, Rates>();
  for (const teamId of rowTeamIds) {
    const r = byTeam.get(teamId);
    if (!r) throw new Error(`aggregate_week playoff: team ${teamId} has no week-18 row to freeze`);
    rates.set(teamId, {
      overallEpaPerPlay: r.overallEpaPerPlay,
      offensiveEpaPerPlay: r.offensiveEpaPerPlay,
      defensiveEpaPerPlay: r.defensiveEpaPerPlay,
      offensivePassEpaPerPlay: r.offensivePassEpaPerPlay,
      offensiveRushEpaPerPlay: r.offensiveRushEpaPerPlay,
      defensivePassEpaPerPlay: r.defensivePassEpaPerPlay,
      defensiveRushEpaPerPlay: r.defensiveRushEpaPerPlay,
      sosRank: r.sosRank,
      pointsScoredPerGame: r.pointsScoredPerGame,
      passYardsPerGame: r.passYardsPerGame,
      rushYardsPerGame: r.rushYardsPerGame,
      pointsAllowedPerGame: r.pointsAllowedPerGame,
      passYardsAllowedPerGame: r.passYardsAllowedPerGame,
      rushYardsAllowedPerGame: r.rushYardsAllowedPerGame,
    });
  }
  return rates;
}

// --- helpers ---

async function loadEloByWeek(
  db: Db,
  seasonId: number,
  maxWeek: number,
): Promise<Map<number, Map<number, number>>> {
  const rows = await db
    .select({ teamId: teamWeekStats.teamId, week: teamWeekStats.week, eloRating: teamWeekStats.eloRating })
    .from(teamWeekStats)
    .where(and(eq(teamWeekStats.seasonId, seasonId), sql`${teamWeekStats.week} BETWEEN 0 AND ${maxWeek}`));
  const byWeek = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const m = byWeek.get(r.week) ?? new Map<number, number>();
    m.set(r.teamId, r.eloRating);
    byWeek.set(r.week, m);
  }
  return byWeek;
}

function epaMap(rows: Record<string, unknown>[]): Map<number, { all: number; pass: number; rush: number }> {
  const m = new Map<number, { all: number; pass: number; rush: number }>();
  for (const r of rows) {
    m.set(Number(r.team), {
      all: r.all_epa == null ? 0 : Number(r.all_epa),
      pass: r.pass_epa == null ? 0 : Number(r.pass_epa),
      rush: r.rush_epa == null ? 0 : Number(r.rush_epa),
    });
  }
  return m;
}

function yardMap(rows: Record<string, unknown>[]): Map<number, { pass: number; rush: number }> {
  const m = new Map<number, { pass: number; rush: number }>();
  for (const r of rows) {
    m.set(Number(r.team), {
      pass: r.pass_y == null ? 0 : Number(r.pass_y),
      rush: r.rush_y == null ? 0 : Number(r.rush_y),
    });
  }
  return m;
}

// ON CONFLICT DO UPDATE set for every teamWeekStats column except the key/id.
function buildExcludedSet(): Record<string, SQL> {
  const exclude = ["id", "teamId", "seasonId", "week"];
  const set: Record<string, SQL> = {};
  for (const key of Object.keys(getTableColumns(teamWeekStats))) {
    if (exclude.includes(key)) continue;
    set[key] = sql.raw(`excluded.${snakeCase(key)}`);
  }
  return set;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
