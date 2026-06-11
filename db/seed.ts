/**
 * Bootstrap seed. Run once on a fresh database before real ingestion exists.
 * Re-runs are safe (idempotent no-ops on existing rows via onConflictDoNothing)
 * but pointless once Slice 3 ingestion is producing real data — the seed will
 * silently fail to insert anything because the natural keys already exist.
 *
 * Scope (matches the Chunk 2 success criterion):
 *   - 1 season row (2024)
 *   - 32 team rows (from TEAM_BRAND)
 *   - 32 week=0 team_week_stats rows (pre-Week-1 baseline: ELO regressed
 *     toward 1500, zeros elsewhere, 0-0-0 record)
 *   - 32 week=1 team_week_stats rows (post-Week-1 realistic-looking values)
 *   - 16 Week 1 game rows (status=final, scored — historical, anchors the
 *     snapshot pattern, NOT rendered by the dashboard)
 *   - 16 Week 2 game rows (status=scheduled, no scores — what the
 *     dashboard renders, joined to week=1 stats via tws.week = g.week - 1)
 *
 * Values are plausible 2024 Week 1 outcomes and ELO/EPA approximations
 * — NOT historically exact. The point is realistic spread for UX
 * evaluation of the Slate Dashboard skeleton. Tighten against real nflverse
 * data before Slice 3 ingestion would overwrite anything.
 *
 * Usage: npm run db:seed
 */

import { config } from "dotenv";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import ws from "ws";

import * as schema from "./schema";
import { TEAM_BRAND, ALL_TEAM_ABBREVIATIONS } from "@/data/teams";

config({ path: ".env.local" });
neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema, casing: "snake_case" });

// ============================================================================
// SEASON
// ============================================================================

const SEASON_YEAR = 2024;
const SEASON_START = "2024-09-05"; // Thursday opener: BAL @ KC
const SEASON_END = "2025-02-09"; // Super Bowl LIX

// ============================================================================
// WEEK 0 STATS (pre-season baseline)
//
// Per the snapshot pattern: ELO regressed from prior season toward 1500
// (the ADR-0004 regression rate isn't pinned here — these values are
// plausible spreads, not derived from real 2023 finals). All EPA, per-game,
// and record fields are zero. SOS rank reflects pre-season schedule
// strength estimate (1 = hardest schedule).
// ============================================================================

// [eloRating, sosRank]
const WEEK_0_BASELINE: Record<string, readonly [number, number]> = {
  // AFC
  BAL: [1605, 12], BUF: [1590, 18], KC: [1610, 22], CIN: [1565, 8],
  MIA: [1545, 25], NYJ: [1525, 10], NE: [1450, 6], PIT: [1530, 16],
  CLE: [1510, 14], HOU: [1555, 20], JAX: [1500, 24], IND: [1495, 17],
  TEN: [1465, 9], DEN: [1445, 19], LV: [1475, 11], LAC: [1505, 13],
  // NFC
  PHI: [1580, 21], DAL: [1555, 28], NYG: [1465, 7], WAS: [1455, 15],
  DET: [1595, 26], GB: [1570, 23], MIN: [1500, 5], CHI: [1480, 4],
  TB: [1445, 27], ATL: [1495, 30], NO: [1490, 29], CAR: [1420, 3],
  SF: [1600, 1], LA: [1545, 2], SEA: [1485, 31], ARI: [1470, 32],
};

// ============================================================================
// WEEK 1 RESULTS — 16 games (best-effort 2024 actuals)
// ============================================================================

type Week1Game = {
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  date: string; // ISO with TZ
  isInternational?: boolean;
  isNeutralSite?: boolean;
  temperature?: number;
  windMph?: number;
  weatherCondition?: string;
};

const WEEK_1_GAMES: Week1Game[] = [
  { away: "BAL", home: "KC", awayScore: 20, homeScore: 27, date: "2024-09-05T20:20:00-04:00", weatherCondition: "clear", temperature: 75, windMph: 6 },
  { away: "GB",  home: "PHI", awayScore: 29, homeScore: 34, date: "2024-09-06T20:15:00-03:00", isInternational: true, isNeutralSite: true },
  { away: "PIT", home: "ATL", awayScore: 18, homeScore: 10, date: "2024-09-08T13:00:00-04:00", temperature: 78, windMph: 5, weatherCondition: "partly cloudy" },
  { away: "ARI", home: "BUF", awayScore: 28, homeScore: 34, date: "2024-09-08T13:00:00-04:00", temperature: 70, windMph: 8, weatherCondition: "clear" },
  { away: "TEN", home: "CHI", awayScore: 17, homeScore: 24, date: "2024-09-08T13:00:00-04:00", temperature: 72, windMph: 10, weatherCondition: "overcast" },
  { away: "NE",  home: "CIN", awayScore: 16, homeScore: 10, date: "2024-09-08T13:00:00-04:00", temperature: 74, windMph: 4, weatherCondition: "clear" },
  { away: "HOU", home: "IND", awayScore: 29, homeScore: 27, date: "2024-09-08T13:00:00-04:00" /* dome */ },
  { away: "JAX", home: "MIA", awayScore: 17, homeScore: 20, date: "2024-09-08T13:00:00-04:00", temperature: 88, windMph: 9, weatherCondition: "humid" },
  { away: "CAR", home: "NO",  awayScore: 10, homeScore: 47, date: "2024-09-08T13:00:00-04:00" /* dome */ },
  { away: "MIN", home: "NYG", awayScore: 28, homeScore: 6,  date: "2024-09-08T13:00:00-04:00", temperature: 75, windMph: 7, weatherCondition: "clear" },
  { away: "DAL", home: "CLE", awayScore: 33, homeScore: 17, date: "2024-09-08T16:25:00-04:00", temperature: 71, windMph: 11, weatherCondition: "clear" },
  { away: "LV",  home: "LAC", awayScore: 10, homeScore: 22, date: "2024-09-08T16:05:00-07:00", temperature: 82, windMph: 4, weatherCondition: "clear" },
  { away: "DEN", home: "SEA", awayScore: 20, homeScore: 26, date: "2024-09-08T16:05:00-07:00", temperature: 65, windMph: 12, weatherCondition: "overcast" },
  { away: "WAS", home: "TB",  awayScore: 20, homeScore: 37, date: "2024-09-08T16:25:00-04:00", temperature: 86, windMph: 6, weatherCondition: "partly cloudy" },
  { away: "LA",  home: "DET", awayScore: 20, homeScore: 26, date: "2024-09-08T20:20:00-04:00" /* dome */ },
  { away: "NYJ", home: "SF",  awayScore: 19, homeScore: 32, date: "2024-09-09T20:15:00-07:00", temperature: 68, windMph: 8, weatherCondition: "clear" },
];

// ============================================================================
// WEEK 1 STATS (post-Week-1 snapshot)
//
// Format: [eloRating, eloChange, sosRank, w, l, t,
//          overallEpa, offEpa, defEpa,
//          offPassEpa, offRushEpa, defPassEpa, defRushEpa,
//          ptsFor, passYds, rushYds, ptsAgainst, passYdsAgainst, rushYdsAgainst]
//
// Sign convention (ADR-0002): defensive values stored as "what they allow"
// — negative = good defense (suppresses opponent EP), positive = bad.
// ============================================================================

type Week1Stats = readonly [
  elo: number, eloChange: number, sosRank: number,
  w: number, l: number, t: number,
  overallEpa: number, offEpa: number, defEpa: number,
  offPass: number, offRush: number, defPass: number, defRush: number,
  pf: number, passYds: number, rushYds: number,
  pa: number, passYdsA: number, rushYdsA: number,
];

const WEEK_1_STATS: Record<string, Week1Stats> = {
  // Winners
  KC:  [1626,  16, 22, 1, 0, 0,  0.08,  0.10, -0.06,  0.14,  0.02, -0.08, -0.03, 27, 245, 120, 20, 210, 80],
  PHI: [1602,  22, 21, 1, 0, 0,  0.14,  0.18, -0.10,  0.22,  0.10, -0.14, -0.05, 34, 290, 165, 29, 245, 110],
  PIT: [1556,  26, 16, 1, 0, 0,  0.12, -0.02, -0.26,  0.04, -0.10, -0.30, -0.22, 18, 195, 135, 10, 150, 70],
  BUF: [1611,  21, 18, 1, 0, 0,  0.16,  0.20, -0.12,  0.24,  0.12, -0.16, -0.08, 34, 305, 145, 28, 235, 95],
  CHI: [1503,  23,  4, 1, 0, 0,  0.06,  0.04, -0.08,  0.02,  0.08, -0.06, -0.10, 24, 215, 155, 17, 195, 105],
  NE:  [1478,  28,  6, 1, 0, 0,  0.04,  0.00, -0.08, -0.02,  0.02, -0.10, -0.06, 16, 180, 130, 10, 165, 85],
  HOU: [1574,  19, 20, 1, 0, 0,  0.10,  0.14, -0.06,  0.18,  0.06, -0.08, -0.04, 29, 275, 115, 27, 240, 105],
  MIA: [1561,  16, 25, 1, 0, 0,  0.06,  0.08, -0.04,  0.12,  0.02, -0.06, -0.02, 20, 230, 100, 17, 195, 85],
  NO:  [1525,  35, 29, 1, 0, 0,  0.32,  0.34, -0.30,  0.40,  0.28, -0.32, -0.28, 47, 340, 215, 10, 165, 75],
  MIN: [1534,  34,  5, 1, 0, 0,  0.28,  0.22, -0.34,  0.28,  0.14, -0.36, -0.32, 28, 270, 140, 6,  140, 60],
  DAL: [1590,  35, 28, 1, 0, 0,  0.22,  0.26, -0.18,  0.32,  0.16, -0.20, -0.16, 33, 295, 175, 17, 195, 105],
  LAC: [1530,  25, 13, 1, 0, 0,  0.16,  0.10, -0.22,  0.14,  0.06, -0.24, -0.20, 22, 215, 165, 10, 175, 80],
  SEA: [1505,  20, 31, 1, 0, 0,  0.08,  0.06, -0.10,  0.10,  0.02, -0.12, -0.08, 26, 245, 120, 20, 220, 90],
  TB:  [1480,  35, 27, 1, 0, 0,  0.28,  0.30, -0.26,  0.36,  0.22, -0.28, -0.22, 37, 305, 180, 20, 215, 90],
  DET: [1610,  15, 26, 1, 0, 0,  0.10,  0.12, -0.08,  0.16,  0.06, -0.10, -0.04, 26, 260, 130, 20, 215, 95],
  SF:  [1615,  15,  1, 1, 0, 0,  0.18,  0.20, -0.16,  0.24,  0.14, -0.18, -0.12, 32, 285, 175, 19, 200, 85],
  // Losers
  BAL: [1589, -16, 12, 0, 1, 0, -0.08, -0.06,  0.10, -0.02, -0.12,  0.08,  0.14, 20, 220, 110, 27, 250, 115],
  GB:  [1548, -22, 23, 0, 1, 0, -0.14, -0.10,  0.18, -0.04, -0.18,  0.22,  0.12, 29, 250, 130, 34, 290, 160],
  ATL: [1469, -26, 30, 0, 1, 0, -0.12,  0.02,  0.26,  0.06, -0.04,  0.22,  0.30, 10, 165, 80,  18, 200, 130],
  ARI: [1449, -21, 32, 0, 1, 0, -0.16, -0.12,  0.20, -0.04, -0.22,  0.16,  0.26, 28, 235, 100, 34, 305, 145],
  TEN: [1442, -23,  9, 0, 1, 0, -0.06,  0.00,  0.12,  0.04, -0.08,  0.10,  0.16, 17, 200, 110, 24, 220, 155],
  CIN: [1537, -28,  8, 0, 1, 0, -0.04, -0.06,  0.04, -0.02, -0.12,  0.06,  0.02, 10, 175, 90,  16, 185, 130],
  IND: [1476, -19, 17, 0, 1, 0, -0.10, -0.08,  0.12, -0.04, -0.14,  0.08,  0.18, 27, 245, 110, 29, 275, 120],
  JAX: [1484, -16, 24, 0, 1, 0, -0.06, -0.02,  0.08,  0.00, -0.06,  0.06,  0.10, 17, 200, 95,  20, 230, 100],
  CAR: [1385, -35,  3, 0, 1, 0, -0.32, -0.30,  0.32, -0.24, -0.36,  0.28,  0.36, 10, 165, 60,  47, 340, 220],
  NYG: [1431, -34,  7, 0, 1, 0, -0.30, -0.28,  0.32, -0.22, -0.34,  0.30,  0.34, 6,  150, 65,  28, 270, 145],
  CLE: [1475, -35, 14, 0, 1, 0, -0.20, -0.16,  0.22, -0.10, -0.22,  0.18,  0.28, 17, 195, 100, 33, 295, 175],
  LV:  [1450, -25, 11, 0, 1, 0, -0.14, -0.12,  0.16, -0.06, -0.18,  0.14,  0.20, 10, 175, 80,  22, 215, 165],
  DEN: [1425, -20, 19, 0, 1, 0, -0.06, -0.04,  0.08,  0.00, -0.08,  0.04,  0.12, 20, 220, 95,  26, 245, 125],
  WAS: [1420, -35, 15, 0, 1, 0, -0.24, -0.22,  0.26, -0.16, -0.28,  0.20,  0.32, 20, 215, 90,  37, 305, 180],
  LA:  [1530, -15,  2, 0, 1, 0, -0.06, -0.04,  0.08, -0.02, -0.06,  0.04,  0.12, 20, 220, 95,  26, 260, 135],
  NYJ: [1510, -15, 10, 0, 1, 0, -0.10, -0.08,  0.12, -0.04, -0.12,  0.08,  0.16, 19, 215, 110, 32, 285, 175],
};

// ============================================================================
// WEEK 2 GAMES — 16 games, status=scheduled, no scores
// These are what the dashboard renders cards for.
// ============================================================================

type Week2Game = {
  away: string;
  home: string;
  date: string;
  temperature?: number;
  windMph?: number;
  precipitationChance?: number;
  weatherCondition?: string;
};

const WEEK_2_GAMES: Week2Game[] = [
  { away: "BUF", home: "MIA", date: "2024-09-12T20:15:00-04:00", temperature: 86, windMph: 8, weatherCondition: "humid" },
  { away: "NO",  home: "DAL", date: "2024-09-15T13:00:00-04:00" /* dome */ },
  { away: "LAC", home: "CAR", date: "2024-09-15T13:00:00-04:00", temperature: 81, windMph: 5, weatherCondition: "clear" },
  { away: "LV",  home: "BAL", date: "2024-09-15T13:00:00-04:00", temperature: 74, windMph: 7, weatherCondition: "clear" },
  { away: "IND", home: "GB",  date: "2024-09-15T13:00:00-04:00", temperature: 68, windMph: 9, weatherCondition: "partly cloudy" },
  { away: "JAX", home: "CLE", date: "2024-09-15T13:00:00-04:00", temperature: 70, windMph: 11, precipitationChance: 30, weatherCondition: "light rain" },
  { away: "NYJ", home: "TEN", date: "2024-09-15T13:00:00-04:00", temperature: 79, windMph: 6, weatherCondition: "clear" },
  { away: "PIT", home: "DEN", date: "2024-09-15T16:25:00-04:00", temperature: 62, windMph: 4, weatherCondition: "clear" },
  { away: "SF",  home: "MIN", date: "2024-09-15T13:00:00-04:00" /* dome */ },
  { away: "SEA", home: "NE",  date: "2024-09-15T13:00:00-04:00", temperature: 72, windMph: 8, weatherCondition: "overcast" },
  { away: "CIN", home: "KC",  date: "2024-09-15T16:25:00-04:00", temperature: 80, windMph: 7, weatherCondition: "clear" },
  { away: "NYG", home: "WAS", date: "2024-09-15T13:00:00-04:00", temperature: 76, windMph: 5, weatherCondition: "clear" },
  { away: "LA",  home: "ARI", date: "2024-09-15T16:05:00-07:00" /* dome */ },
  { away: "TB",  home: "DET", date: "2024-09-15T13:00:00-04:00" /* dome */ },
  { away: "CHI", home: "HOU", date: "2024-09-15T20:20:00-04:00" /* dome */ },
  { away: "PHI", home: "ATL", date: "2024-09-16T20:15:00-04:00", temperature: 77, windMph: 4, weatherCondition: "clear" },
];

// ============================================================================
// EXECUTION
// ============================================================================

async function main() {
  console.log("Seeding NFL Analytics dev branch...\n");

  // --- 1. Season ---
  await db
    .insert(schema.season)
    .values({
      year: SEASON_YEAR,
      startDate: SEASON_START,
      endDate: SEASON_END,
    })
    .onConflictDoNothing();

  const seasonRow = await db
    .select()
    .from(schema.season)
    .where(eq(schema.season.year, SEASON_YEAR))
    .limit(1);
  if (seasonRow.length === 0) throw new Error("Season not found after insert");
  const seasonId = seasonRow[0].id;
  console.log(`✓ season ${SEASON_YEAR} → id ${seasonId}`);

  // --- 2. Teams ---
  await db
    .insert(schema.team)
    .values(
      ALL_TEAM_ABBREVIATIONS.map((abbr) => {
        const brand = TEAM_BRAND[abbr];
        return {
          abbreviation: brand.abbreviation,
          conference: brand.conference,
          division: brand.division,
        };
      }),
    )
    .onConflictDoNothing();

  const teamRows = await db.select().from(schema.team);
  const teamIdByAbbr = new Map(teamRows.map((t) => [t.abbreviation, t.id]));
  console.log(`✓ teams: ${teamRows.length}`);

  // --- 3. Week 0 baseline stats ---
  const week0Rows = ALL_TEAM_ABBREVIATIONS.map((abbr) => {
    const [elo, sosRank] = WEEK_0_BASELINE[abbr];
    const teamId = teamIdByAbbr.get(abbr)!;
    return {
      teamId,
      seasonId,
      week: 0,
      overallEpaPerPlay: 0,
      offensiveEpaPerPlay: 0,
      defensiveEpaPerPlay: 0,
      offensivePassEpaPerPlay: 0,
      offensiveRushEpaPerPlay: 0,
      defensivePassEpaPerPlay: 0,
      defensiveRushEpaPerPlay: 0,
      eloRating: elo,
      eloChange: 0,
      sosRank,
      recordWins: 0,
      recordLosses: 0,
      recordTies: 0,
      pointsScoredPerGame: 0,
      passYardsPerGame: 0,
      rushYardsPerGame: 0,
      pointsAllowedPerGame: 0,
      passYardsAllowedPerGame: 0,
      rushYardsAllowedPerGame: 0,
    };
  });
  await db.insert(schema.teamWeekStats).values(week0Rows).onConflictDoNothing();
  console.log(`✓ team_week_stats week=0: ${week0Rows.length}`);

  // --- 4. Week 1 stats ---
  const week1Rows = ALL_TEAM_ABBREVIATIONS.map((abbr) => {
    const s = WEEK_1_STATS[abbr];
    const teamId = teamIdByAbbr.get(abbr)!;
    return {
      teamId,
      seasonId,
      week: 1,
      eloRating: s[0],
      eloChange: s[1],
      sosRank: s[2],
      recordWins: s[3],
      recordLosses: s[4],
      recordTies: s[5],
      overallEpaPerPlay: s[6],
      offensiveEpaPerPlay: s[7],
      defensiveEpaPerPlay: s[8],
      offensivePassEpaPerPlay: s[9],
      offensiveRushEpaPerPlay: s[10],
      defensivePassEpaPerPlay: s[11],
      defensiveRushEpaPerPlay: s[12],
      pointsScoredPerGame: s[13],
      passYardsPerGame: s[14],
      rushYardsPerGame: s[15],
      pointsAllowedPerGame: s[16],
      passYardsAllowedPerGame: s[17],
      rushYardsAllowedPerGame: s[18],
    };
  });
  await db.insert(schema.teamWeekStats).values(week1Rows).onConflictDoNothing();
  console.log(`✓ team_week_stats week=1: ${week1Rows.length}`);

  // --- 5. Week 1 games (status=final, scored) ---
  const week1GameRows = WEEK_1_GAMES.map((g) => ({
    seasonId,
    week: 1,
    gameType: "regular" as const,
    homeTeamId: teamIdByAbbr.get(g.home)!,
    awayTeamId: teamIdByAbbr.get(g.away)!,
    gameDateTime: new Date(g.date),
    isNeutralSite: g.isNeutralSite ?? false,
    isInternational: g.isInternational ?? false,
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    status: "final" as const,
    temperature: g.temperature ?? null,
    windMph: g.windMph ?? null,
    precipitationChance: null,
    weatherCondition: g.weatherCondition ?? null,
    nflverseGameId: `2024_01_${g.away}_${g.home}`,
    oddsApiEventId: null,
  }));
  await db.insert(schema.game).values(week1GameRows).onConflictDoNothing();
  console.log(`✓ games week=1: ${week1GameRows.length}`);

  // --- 6. Week 2 games (status=scheduled, no scores) ---
  const week2GameRows = WEEK_2_GAMES.map((g) => ({
    seasonId,
    week: 2,
    gameType: "regular" as const,
    homeTeamId: teamIdByAbbr.get(g.home)!,
    awayTeamId: teamIdByAbbr.get(g.away)!,
    gameDateTime: new Date(g.date),
    isNeutralSite: false,
    isInternational: false,
    homeScore: null,
    awayScore: null,
    status: "scheduled" as const,
    temperature: g.temperature ?? null,
    windMph: g.windMph ?? null,
    precipitationChance: g.precipitationChance ?? null,
    weatherCondition: g.weatherCondition ?? null,
    nflverseGameId: `2024_02_${g.away}_${g.home}`,
    oddsApiEventId: null,
  }));
  await db.insert(schema.game).values(week2GameRows).onConflictDoNothing();
  console.log(`✓ games week=2: ${week2GameRows.length}`);

  console.log("\nSeed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
