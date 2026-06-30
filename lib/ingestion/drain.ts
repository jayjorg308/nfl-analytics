// Phase 3b drain (ADR-0016). Stall-sweep → claim → dispatch → retry/backoff, bounded by
// the Vercel 300s budget. Invokes the chunk-3/4 handlers; it is the ONLY place job status
// transitions. SCOPE: the drain FUNCTION only — cron routes / vercel.json / auth are next.
//
// INSERT-only-from-discovery (ADR-0028 §5, trap #5a): the drain NEVER INSERTs into job_queue.
// A job that must retry is UPDATEd in place (its own row). Only discovery + the manual runbook
// insert.
//
// nodejs runtime only (pooled client — real transactions for FOR UPDATE SKIP LOCKED).

import { sql } from "drizzle-orm";

import type { Db } from "@/db";
import type { AggregateWeekPayload, IngestGamePayload } from "@/db/schema";

import { aggregateWeek } from "./aggregate-week";
import { ingestGame } from "./ingest-game";

// Retry schedule (ADR-0016): 1h, 2h, 4h, 8h, 16h (~31h) then `failed`. A stall counts as an
// attempt toward this cap (ADR-0016 "treated as a failed attempt").
const BACKOFF_HOURS = [1, 2, 4, 8, 16];
const MAX_ATTEMPTS = BACKOFF_HOURS.length; // 5

// A handler stuck in_progress past this is a crashed handler / function timeout (ADR-0016).
const STALL_THRESHOLD_MINUTES = 15;

// Vercel function ceiling (ADR-0008 / ADR-0016). Stop CLAIMING new jobs once the remaining
// budget is under the headroom, so we never start a job we cannot finish in-window; the next
// invocation resumes (crash-safe). Headroom is sized from one ingest_game's measured wall time
// (dominated by the v1-lean ~20MB season-pbp refetch) — see the report / the measurement.
const DRAIN_BUDGET_MS = 300_000;
const DRAIN_HEADROOM_MS = 30_000;

// --- dispatch: narrow the payload by jobType ONCE at the drain boundary (ADR-0026) ---

type ClaimedJob = {
  id: number;
  jobType: "ingest_game" | "aggregate_week";
  payload: unknown;
  retryCount: number;
};

const HANDLERS = { ingest_game: ingestGame, aggregate_week: aggregateWeek } as const;

async function dispatch(db: Db, job: ClaimedJob): Promise<void> {
  switch (job.jobType) {
    case "ingest_game":
      await HANDLERS.ingest_game(db, job.payload as IngestGamePayload);
      return;
    case "aggregate_week":
      await HANDLERS.aggregate_week(db, job.payload as AggregateWeekPayload);
      return;
    default:
      throw new Error(`drain: unknown jobType ${(job as ClaimedJob).jobType}`);
  }
}

// --- stall sweep (ADR-0016) — runs FIRST, before claiming ---

/**
 * Reclaim crashed/timed-out handlers: in_progress jobs whose startedAt is older than the
 * stall threshold reset to pending with retryCount incremented (a failed attempt toward the
 * cap → `failed` if it exhausts the budget). No fresh time-backoff: the 15-min detection
 * window already paces re-attempts. Returns the number of jobs swept.
 */
export async function stallSweep(db: Db, now: Date): Promise<number> {
  const res = await db.execute(sql`
    UPDATE job_queue SET
      retry_count = retry_count + 1,
      started_at = NULL,
      status = CASE WHEN retry_count + 1 > ${MAX_ATTEMPTS} THEN 'failed'::job_status ELSE 'pending'::job_status END
    WHERE status = 'in_progress'
      AND started_at IS NOT NULL
      AND started_at < ${now}::timestamptz - ${STALL_THRESHOLD_MINUTES} * interval '1 minute'
  `);
  return res.rowCount ?? 0;
}

// --- claim one job (ADR-0016 drain query) ---

/**
 * Claim the oldest runnable job: status=pending AND notBefore due, FOR UPDATE SKIP LOCKED so
 * concurrent drains never double-process. The select + the in_progress mark are one short
 * transaction (the lock is held only across the claim); the handler then runs unlocked.
 */
async function claimNextJob(db: Db, now: Date): Promise<ClaimedJob | null> {
  return db.transaction(async (tx) => {
    const rows = (
      await tx.execute(sql`
        SELECT id, job_type, payload, retry_count
        FROM job_queue
        WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ${now}::timestamptz)
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `)
    ).rows as Record<string, unknown>[];
    if (rows.length === 0) return null;
    const row = rows[0];
    await tx.execute(sql`
      UPDATE job_queue SET status = 'in_progress', started_at = ${now}::timestamptz WHERE id = ${row.id as number}
    `);
    return {
      id: Number(row.id),
      jobType: row.job_type as ClaimedJob["jobType"],
      payload: row.payload,
      retryCount: Number(row.retry_count),
    };
  });
}

// --- result transitions (the drain UPDATEs the job row — never INSERTs) ---

async function markCompleted(db: Db, id: number): Promise<void> {
  await db.execute(sql`UPDATE job_queue SET status = 'completed' WHERE id = ${id}`);
}

/**
 * A thrown handler is a failed attempt. retryCount++; once it exhausts the 5 backoffs the job
 * is `failed` (ADR-0016). This is the ONE retry path BOTH a gate fail (CompletenessGateError)
 * and non-arrival (404 / empty plays → gate fail) feed into — uniform throw→backoff, no
 * special-casing (ADR-0019).
 */
async function handleFailure(db: Db, job: ClaimedJob, now: Date): Promise<"failed" | "pending"> {
  const nextRetry = job.retryCount + 1;
  if (nextRetry > MAX_ATTEMPTS) {
    await db.execute(sql`UPDATE job_queue SET status = 'failed', retry_count = ${nextRetry}, started_at = NULL WHERE id = ${job.id}`);
    return "failed";
  }
  const backoffHours = BACKOFF_HOURS[nextRetry - 1];
  await db.execute(sql`
    UPDATE job_queue SET
      status = 'pending',
      retry_count = ${nextRetry},
      not_before = ${now}::timestamptz + ${backoffHours} * interval '1 hour',
      started_at = NULL
    WHERE id = ${job.id}
  `);
  return "pending";
}

// --- the drain loop ---

export type DrainResult = {
  swept: number;
  completed: number;
  retried: number;
  failed: number;
  processedJobIds: number[];
};

/**
 * One drain invocation (ADR-0016). `now` drives all timestamp/notBefore logic (deterministic +
 * testable); the budget loop uses real wall-clock elapsed time, since it is bounding the actual
 * function runtime. Pull-and-process oldest-first until headroom is reached, then return — the
 * next invocation resumes any remainder.
 */
export async function drainOnce(db: Db, now: Date): Promise<DrainResult> {
  const swept = await stallSweep(db, now);
  const result: DrainResult = { swept, completed: 0, retried: 0, failed: 0, processedJobIds: [] };

  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < DRAIN_BUDGET_MS - DRAIN_HEADROOM_MS) {
    const job = await claimNextJob(db, now);
    if (!job) break; // queue drained

    result.processedJobIds.push(job.id);
    try {
      await dispatch(db, job);
      await markCompleted(db, job.id);
      result.completed += 1;
    } catch {
      const outcome = await handleFailure(db, job, now);
      if (outcome === "failed") result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
