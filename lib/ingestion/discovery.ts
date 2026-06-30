// Phase 3b discovery enumerator (ADR-0028 §5 assembly).
//
// Each run enumerates the active window {N-1, N} over the SCHEDULE and ensures every
// not-yet-complete unit of work has a live job. Targeting keys PURELY on DATA-state
// (filter (ii), the reads in THIS file), never on job-status; dedup against live jobs
// (filter (i)) lives in ensureJobEnqueued. The two filters are deliberately separate
// code paths:
//   - filter (ii) — "does this unit still need work?" — reads `game.playsFrozenAt`
//     (ingest) and `team_week_stats` existence (aggregate). DATA-state only.
//   - filter (i)  — "is there already a live job for it?" — the pending/in_progress
//     ensure-exists guard, inside ensureJobEnqueued.
//
// Discovery is INSERT-only via ensureJobEnqueued (ADR-0028 §5 invariant a) and needs
// no singleton lock: re-running or overlapping runs recompute the same target set and
// the guard dedups (ADR-0028 "Discovery's own idempotency").
//
// nodejs runtime only (pooled DB client — see db/index.ts).

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "@/db";
import { game, season, teamWeekStats } from "@/db/schema";

import { ensureJobEnqueued } from "./job-queue";
import type { ScheduledGame } from "./schedule";

/** Score-presence in the schedule == finality (ADR-0028 §4). */
function isScored(g: ScheduledGame): boolean {
  return g.homeScore !== null && g.awayScore !== null;
}

/**
 * Current NFL week N = the latest week whose games have started as of `now` — the
 * "week bracketing now", season-floored (ADR-0028 §3). Before the season's first
 * kickoff, N is the earliest scheduled week. Derived from the SCHEDULE (kickoff
 * dates), NOT the `game` table: discovery does not pre-create the forward season's
 * `game` rows (ADR-0028 §1), so the table cannot answer this for 2026 wk1+.
 *
 * `schedule` must already be scoped to the current season (the caller filters).
 */
export function deriveCurrentWeek(schedule: ScheduledGame[], now: Date): number {
  if (schedule.length === 0) {
    throw new Error("deriveCurrentWeek: empty schedule for the current season.");
  }
  const started = schedule.filter((g) => g.kickoff.getTime() <= now.getTime());
  return started.length > 0
    ? Math.max(...started.map((g) => g.week))
    : Math.min(...schedule.map((g) => g.week));
}

export type DiscoveryResult = {
  seasonYear: number;
  currentWeek: number;
  /** The active window {N-1, N}, season-floored at 0. */
  weeks: number[];
  /** nflverseGameIds for which a fresh ingest_game job was inserted this run. */
  ingestEnqueued: string[];
  /** Weeks for which a fresh aggregate_week job was inserted this run. */
  aggregateEnqueued: number[];
};

/**
 * Enumerate the active window and ensure-exists-enqueue every not-yet-complete unit.
 * `schedule` is the current season's slate (injected — see schedule.ts's seam note);
 * `now` is injected for testability (the cron passes `new Date()`).
 */
export async function enumerateAndEnqueue(
  db: Db,
  schedule: ScheduledGame[],
  now: Date,
): Promise<DiscoveryResult> {
  if (schedule.length === 0) {
    throw new Error("Discovery: empty schedule — cannot enumerate the active window.");
  }

  // Current season = the season the schedule covers (the latest year present).
  const seasonYear = Math.max(...schedule.map((g) => g.seasonYear));
  const currentSeason = schedule.filter((g) => g.seasonYear === seasonYear);

  const currentWeek = deriveCurrentWeek(currentSeason, now);
  // Active window {N-1, N}, floored at week 0 within the season (ADR-0028 §3) — the
  // floor keeps the reach-back from crossing into the prior season's week 22.
  const weeks = [currentWeek - 1, currentWeek].filter((w) => w >= 0);

  // Resolve the season FK for the data-state reads below.
  const seasonRows = await db
    .select({ id: season.id })
    .from(season)
    .where(eq(season.year, seasonYear));
  const seasonId = seasonRows[0]?.id;
  if (seasonId === undefined) {
    throw new Error(
      `Discovery: no season row for year ${seasonYear} — seed the season before forward ingestion.`,
    );
  }

  // --- filter (ii): DATA-STATE reads (never job-status) ---

  // Gate-passed games in the window: playsFrozenAt IS NOT NULL == frozen (ADR-0028 §1).
  // Note: play-PRESENCE is NOT used here — a failed gate commits partial plays with a
  // null marker, so the marker (not play rows) is the completeness signal.
  const frozenRows = await db
    .select({ nflverseGameId: game.nflverseGameId })
    .from(game)
    .where(
      and(
        eq(game.seasonId, seasonId),
        inArray(game.week, weeks),
        isNotNull(game.playsFrozenAt),
      ),
    );
  const frozen = new Set(frozenRows.map((r) => r.nflverseGameId));

  // Weeks that already have team_week_stats — a BARE-EXISTENCE read, sound ONLY
  // because the week's rows are written in one atomic transaction (ADR-0027 (A) #2 /
  // ADR-0028 §2): any row existing implies all committed.
  const aggRows = await db
    .select({ week: teamWeekStats.week })
    .from(teamWeekStats)
    .where(and(eq(teamWeekStats.seasonId, seasonId), inArray(teamWeekStats.week, weeks)));
  const aggregated = new Set(aggRows.map((r) => r.week));

  const ingestEnqueued: string[] = [];
  const aggregateEnqueued: number[] = [];

  for (const week of weeks) {
    const scheduledW = currentSeason.filter((g) => g.week === week);

    // ingest_game targets = scored games MINUS frozen games (filter (ii)). A scoreless
    // game is never enqueued (ADR-0028 §4); a `failed` prior job falls through to a
    // fresh-lineage INSERT because the guard (filter (i)) is live-scoped, not failed-aware.
    for (const g of scheduledW) {
      if (!isScored(g)) continue;
      if (frozen.has(g.nflverseGameId)) continue;
      const inserted = await ensureJobEnqueued(db, {
        jobType: "ingest_game",
        payload: { nflverseGameId: g.nflverseGameId, seasonYear, week },
      });
      if (inserted) ingestEnqueued.push(g.nflverseGameId);
    }

    // aggregate_week target = NOT EXISTS team_week_stats(S,W) AND every scheduled game
    // in W is frozen. This is the ENQUEUE GATE (ADR-0028 §5 relocates the precondition
    // here): the aggregate is enqueued only when ready to succeed, so there is no
    // precondition-unmet retry. Do NOT build a handler-runtime COUNT(complete)==expected
    // backoff — that is ADR-0026's PRE-amendment mechanism (see its 2026-06-19 note).
    if (scheduledW.length === 0) continue; // week 0 / no-game weeks: natural no-op
    if (aggregated.has(week)) continue;
    const allFrozen = scheduledW.every((g) => frozen.has(g.nflverseGameId));
    if (!allFrozen) continue;
    const inserted = await ensureJobEnqueued(db, {
      jobType: "aggregate_week",
      // expectedGames = the scheduled-game count for W, snapshotted at discovery
      // (ADR-0026 denominator / ADR-0028 §5): the handler's execute-time precondition
      // reference count, stable against bracket/flex movement.
      payload: { seasonYear, week, expectedGames: scheduledW.length },
    });
    if (inserted) aggregateEnqueued.push(week);
  }

  return { seasonYear, currentWeek, weeks, ingestEnqueued, aggregateEnqueued };
}
