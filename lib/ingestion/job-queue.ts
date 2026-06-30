// Phase 3b job-queue typing + the typed enqueue layer (ADR-0026 / ADR-0027 / ADR-0028).
//
// This module owns TWO things:
//   1. The row-level discriminated union (`Job`) — the typed shape a drained job
//      takes once narrowed. The `job_type` COLUMN is the sole discriminant; the
//      jsonb payload carries NO discriminant (it can drift from the column — see
//      db/schema.ts). Narrowed ONCE at the drain boundary (a later chunk) so each
//      handler receives a typed payload, never raw jsonb (ADR-0026).
//   2. The ensure-exists enqueue guard — filter (i) (ADR-0027 (B) / ADR-0028 §5).
//
// nodejs runtime only (the pooled @neondatabase/serverless client — see db/index.ts).

import { sql } from "drizzle-orm";

import type { Db } from "@/db";
import type { AggregateWeekPayload, IngestGamePayload } from "@/db/schema";

// The typed job, discriminated on `jobType` (mirrors the `job_type` column).
// `ingest_game` is keyed by `nflverseGameId`; `aggregate_week` by season + week —
// both keys live INSIDE the payload (confirmed against db/schema.ts), never as a
// top-level column.
export type Job =
  | { jobType: "ingest_game"; payload: IngestGamePayload }
  | { jobType: "aggregate_week"; payload: AggregateWeekPayload };

// The logical-key predicate for the ensure-exists guard, derived per job type from
// the jsonb payload. Numeric keys are cast (`::int`) so the comparison is on the
// number, not its text rendering; `nflverseGameId` is a string and compares as text.
function liveKeyMatch(job: Job) {
  switch (job.jobType) {
    case "ingest_game":
      return sql`payload->>'nflverseGameId' = ${job.payload.nflverseGameId}`;
    case "aggregate_week":
      return sql`(payload->>'seasonYear')::int = ${job.payload.seasonYear} AND (payload->>'week')::int = ${job.payload.week}`;
  }
}

/**
 * Ensure-exists enqueue — filter (i) (ADR-0027 (B), ADR-0028 §5). INSERTs the job
 * ONLY when no live job already exists for its logical key. Returns `true` if a row
 * was inserted, `false` if an existing live job made it a no-op.
 *
 * The two paired invariants this upholds (ADR-0028 §5) — breaking EITHER makes
 * filter (i) leak:
 *   (a) INSERT-only-from-discovery: this helper (+ the manual runbook) is the ONLY
 *       INSERT path. A drained job that must retry UPDATEs its OWN row (drain
 *       mechanics, a later chunk); it never calls this to INSERT a fresh row.
 *   (b) LIVE-scoped ensure-exists: the guard skips ONLY on a `pending`/`in_progress`
 *       job — NEVER `completed` (would break ADR-0015 cascade re-enqueue) and NEVER
 *       any-row-including-`failed` (would break the failed-game re-mint, ADR-0028 §3).
 *
 * Racy by design (ADR-0027 "Racy by design"): `WHERE NOT EXISTS` takes no predicate
 * lock, so a same-instant double-fire can leak a duplicate row. This is ACCEPTED —
 * handler idempotency-by-construction (ADR-0027 (A)) makes the rare leak harmless.
 * Do NOT add a UNIQUE index/constraint on the logical key to "fix" the race; ADR-0027
 * rejects that index explicitly.
 */
export async function ensureJobEnqueued(db: Db, job: Job): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO job_queue (job_type, payload)
    SELECT ${job.jobType}::job_type, ${JSON.stringify(job.payload)}::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM job_queue
      WHERE job_type = ${job.jobType}::job_type
        AND status IN ('pending', 'in_progress')
        AND ${liveKeyMatch(job)}
    )
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}
