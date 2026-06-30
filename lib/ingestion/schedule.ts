// The discovery-side view of the nflverse schedule (ADR-0028 §4).
//
// Discovery is SCHEDULE-ONLY: it reads the light schedule file (matchups, scores,
// gameType, dates) and NEVER the heavy play-by-play parquet. The in-game score
// (`total_home_score`/`total_away_score`) is quarantined in the pbp parquet, which
// is the `ingest_game` HANDLER's input — not discovery's. Because the schedule
// carries only the FINAL score (null until the game completes), score-presence in
// the schedule == finality by construction (the repo's established "game was played"
// filter, `home_score & away_score not-null`).

import { gameTypeEnum } from "@/db/schema";

import { asInt, asStr } from "./parse";
import { readReleaseParquet, scheduleReleaseUrl } from "./nflverse";

export type GameType = (typeof gameTypeEnum.enumValues)[number];

/** One scheduled game, projected from the nflverse schedule for discovery. */
export type ScheduledGame = {
  // The ingest logical key + the `game.nflverseGameId` upsert key (e.g. "2026_05_KC_BUF").
  nflverseGameId: string;
  seasonYear: number;
  week: number;
  gameType: GameType;
  // Kickoff — used to derive the current week N (the week bracketing `now`).
  kickoff: Date;
  homeAbbr: string;
  awayAbbr: string;
  // FINAL score; null until the game completes. Both-non-null == finality.
  homeScore: number | null;
  awayScore: number | null;
  // Venue (stadium_id preferred, else stadium name) — the basis for the modal
  // neutral-site derivation below (ingest_game's game-row metadata, ADR-0014).
  venue: string | null;
};

/**
 * Supplies a season's scheduled games to discovery. The gap surfaced in Chunk 1 is
 * resolved by ADR-0029: the concrete reader is `fetchSchedule` below (hyparquet over
 * the nflverse-data release `games.parquet`). The enumerator still takes
 * `ScheduledGame[]` injected, so its targeting logic stays pure/testable; the cron
 * wiring chunk passes `fetchSchedule`.
 */
export type ScheduleSource = (seasonYear: number) => Promise<ScheduledGame[]>;

// --- concrete ScheduleSource (ADR-0029) ---

// nflverse REG/WC/DIV/CON/SB → the schema's game_type enum. Exact map, loud-fail on
// an unknown value — this feeds ADR-0021's carry-forward branch, so a silent miss
// would mis-shape the playoff rows. Mirrors Phase 3a's build.py GAME_TYPE dict.
const NFLVERSE_GAME_TYPE: Record<string, GameType> = {
  REG: "regular",
  WC: "wildcard",
  DIV: "divisional",
  CON: "conference",
  SB: "super_bowl",
};

export function mapGameType(raw: string): GameType {
  const gt = NFLVERSE_GAME_TYPE[raw];
  if (!gt) throw new Error(`Unknown nflverse game_type: ${raw}`);
  return gt;
}

// The light schedule projection (ADR-0028 §4: matchups, scores, gameType, dates) +
// the venue (stadium_id preferred over the renameable stadium name, per Phase 3a's
// _venue_col) for the modal neutral-site derivation.
const SCHEDULE_COLUMNS = [
  "game_id",
  "season",
  "week",
  "game_type",
  "gameday",
  "gametime",
  "home_team",
  "away_team",
  "home_score",
  "away_score",
  "stadium_id",
  "stadium",
];

const ET_ZONE = "America/New_York";

// The America/New_York UTC offset (ms) at a given instant, via the IANA tz database
// (Intl) — so DST is handled exactly, not by a hardcoded month cutoff.
function etOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24, // some engines render midnight as "24"
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - instant.getTime();
}

// nflverse `gameday` (YYYY-MM-DD) + `gametime` (HH:MM, 24-hour EASTERN) → a true UTC
// instant. gametime is ET wall time, NOT UTC — converting via the tz offset is what
// keeps the derived current week N stable around late-night boundaries (Phase 3a's
// build.py does the same with Python ZoneInfo("America/New_York")).
function etKickoffToUtc(gameday: string, gametime: string): Date {
  const [y, mo, d] = gameday.split("-").map(Number);
  const [hh, mm] = gametime.split(":").map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, hh, mm);
  // Two-pass: the offset at the wall-as-UTC guess, refined at the resulting instant
  // (correct across a DST transition).
  let offset = etOffsetMs(new Date(wallAsUtc));
  offset = etOffsetMs(new Date(wallAsUtc - offset));
  return new Date(wallAsUtc - offset);
}

function toScheduledGame(r: Record<string, unknown>): ScheduledGame {
  // gametime is null for some not-yet-timed games; fall back to 13:00 ET (the
  // build.py default) — kickoff only feeds N derivation, where the day is what matters.
  const gametime = (r.gametime as string | null) ?? "13:00";
  return {
    nflverseGameId: String(r.game_id),
    seasonYear: Number(r.season),
    week: Number(r.week),
    gameType: mapGameType(String(r.game_type)),
    kickoff: etKickoffToUtc(String(r.gameday), gametime),
    homeAbbr: String(r.home_team),
    awayAbbr: String(r.away_team),
    homeScore: asInt(r.home_score),
    awayScore: asInt(r.away_score),
    venue: asStr(r.stadium_id) ?? asStr(r.stadium),
  };
}

// --- modal neutral-site derivation (ADR-0014 [HFA-NEUTRAL]; Phase 3a elo.py) ---
//
// Phase 3a derives is_neutral from the team's MODAL home stadium, NOT the schedule's
// `location` flag (unreliable: 2025 flagged 7 games Neutral while at the home team's
// own stadium). This must match Phase 3a — the aggregate_week ELO chain reads
// game.isNeutralSite for HFA, so forward continuity depends on the same derivation.
// Validated: this reproduces Phase 3a's stored 2025 values exactly (0 mismatches).

/** Each home team's modal (most-frequent) home venue across the given games. */
export function homeStadiumModalMap(games: ScheduledGame[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const g of games) {
    if (g.venue == null) continue;
    const m = counts.get(g.homeAbbr) ?? new Map<string, number>();
    m.set(g.venue, (m.get(g.venue) ?? 0) + 1);
    counts.set(g.homeAbbr, m);
  }
  const modal = new Map<string, string>();
  for (const [team, venueCounts] of counts) {
    // count desc, then venue asc — matches pandas .mode().iloc[0] tie-break.
    const top = [...venueCounts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    modal.set(team, top);
  }
  return modal;
}

/** Neutral == venue differs from the home team's modal home stadium (ADR-0014). */
export function deriveIsNeutralSite(game: ScheduledGame, modal: Map<string, string>): boolean {
  if (game.venue == null) return false;
  return game.venue !== modal.get(game.homeAbbr);
}

/** International == neutral AND the venue is no team's modal home venue (build.py). */
export function deriveIsInternational(game: ScheduledGame, modal: Map<string, string>): boolean {
  if (!deriveIsNeutralSite(game, modal)) return false;
  const homeVenues = new Set(modal.values());
  return game.venue != null && !homeVenues.has(game.venue);
}

/**
 * The NFL season year for a given instant. Sept–Dec → that year; Jan–Feb → the prior year
 * (that season is still in its playoffs); Mar–Aug offseason → that year (the UPCOMING season,
 * whose schedule publishes by spring). Phase 3b targets the forward season only — never the
 * Phase-3a-owned past seasons (ADR-0015), so the cron derives its target season from `now`.
 */
export function currentSeasonYear(now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1–12
  return m >= 3 ? y : y - 1;
}

/**
 * Concrete `ScheduleSource` (ADR-0029): read the all-seasons `games.parquet`,
 * column-filtered, and project the requested season's rows to `ScheduledGame[]`.
 */
export const fetchSchedule: ScheduleSource = async (seasonYear) => {
  const rows = await readReleaseParquet(scheduleReleaseUrl(), SCHEDULE_COLUMNS);
  return rows
    .filter((r) => Number(r.season) === seasonYear)
    .map(toScheduledGame);
};
