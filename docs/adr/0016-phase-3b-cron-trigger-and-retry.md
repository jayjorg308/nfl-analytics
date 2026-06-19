# Phase 3b cron trigger and retry pattern

This ADR amends ADR-0006's *"~30 minutes after each day's last game ends"* trigger timing. The freshness contract from ADR-0006 (*"by Monday morning, every Sunday game's stats, EPA, ELO update, and hit-rate impact are fully integrated"*) is preserved unchanged — this amendment is about implementation mechanics, not user-visible commitments.

ADR-0006's 30-minute timing was written before the nflverse parquet release cadence was nailed down. In practice, nflverse releases play-by-play parquet roughly once per day during the season, typically morning Eastern time the day after games complete. A cron firing 30 minutes after the SNF wrap (~12:30am ET Monday) cannot do useful work because the parquet covering Sunday's games doesn't exist yet. The "responsiveness" implied by the 30-minute framing is illusory; the actual constraint is when the data source delivers. **The freshness contract is the durable commitment; trigger timing is an implementation detail that may change again if the source's release cadence changes.**

## Cron architecture: two entries

Phase 3b uses **two cron entries** with distinct responsibilities, both dispatching through the same `HANDLERS` map:

- **Primary scheduled cron** fires Monday, Tuesday, and Friday at 10:00 UTC (~5-6am ET). Aligned to nflverse's release cadence, not to game-end time. On each invocation it discovers expected work for the day, attempts to process available parquet, and enqueues a `jobQueue` retry (with `not_before` set 1 hour out) for anything not yet available. Monday handles Sunday games (and rare Saturday games during the late-season schedule). Tuesday handles Monday Night Football. Friday handles Thursday Night Football.

- **Drain cron** fires every 30 minutes during active ingestion windows. Same SQL drain query (`SELECT ... FROM job_queue WHERE status = 'pending' AND (not_before IS NULL OR not_before <= now()) ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED`), same handler dispatch. Distinct trigger condition: this cron processes whatever the drain query returns regardless of "expected work for the day." `SKIP LOCKED` is defensive against the theoretical case of overlapping cron invocations; payload is Zod-validated at dispatch.

**Active ingestion windows** are **Sunday 23:00 UTC through Tuesday 18:00 UTC** (covering Sunday games + MNF) and **Thursday 23:00 UTC through Friday 18:00 UTC** (covering TNF). Outside these windows the drain cron does not run; there is no expected post-game work to process.

DST is operationally invisible — 10:00 UTC resolves to 06:00 EDT in September-October and 05:00 EST in November-February, both comfortably "Monday morning." International games (London, Munich, Frankfurt) don't require special handling; their parquet rows land in the same release as domestic games for the same week.

## Retry pattern

Retries use **exponential backoff capped at 5 attempts**: 1h, 2h, 4h, 8h, 16h, then mark the job `failed`. The cumulative ~31h retry window aligns with the freshness contract — if data hasn't arrived in 31 hours, something is wrong upstream and human intervention is warranted, not more retries. Stalled jobs (`status = 'in_progress'` for more than 15 minutes, indicating a crashed handler or Vercel function timeout) are reset to `pending` with `retryCount` incremented in a dedicated UPDATE step at the start of each drain run; the stall is treated as a failed attempt for backoff purposes. The 15-minute threshold and reset logic are documented in code with reasoning.

> **Note (2026-06-19): the failure model above is REFINED by [ADR-0028](0028-phase-3b-discovery-completeness-targeting.md) §3.** "5 attempts → `failed` → human attention" describes a single job *lineage*. ADR-0028's discovery re-mints a fresh lineage (`retryCount = 0`) for any not-yet-complete unit still inside its active window, so `failed` is **per-lineage terminal, not per-*game* terminal** — the per-game effective cap is ≈ 5 × (weeks in window) ≈ 10, and the `retryCount` reset on re-enqueue is intentional. **Game-level terminality is delivered by the active window** (a unit falling out after ~2 weeks) **plus observability** (the Slate Dashboard's most-recent-week staleness indicator + the standing `failed` row) — **not** by the `failed` status itself, and not by discovery abstaining. So a reader expecting `failed` to be the end-of-line for a game should consult ADR-0028 §3; the ~31h-per-lineage cap and its rationale here are unchanged.

## Self-healing without operator intervention

The hybrid scheduled-plus-retry pattern produces graceful degradation rather than brittle on-schedule processing. The Monday-morning freshness contract is met under normal conditions; if nflverse runs late, retries fire within hours and the contract is still met by mid-day Monday in the worst common case. Polling every hour during the active window — the alternative considered and rejected — would burn ~168 invocations per week against ~10-15 with the scheduled-plus-drain pattern, without reducing code complexity (the "is data ready?" check is needed either way).

**Active alerting** (email, Slack, PagerDuty) is **deliberately deferred to v2** as a single-operator simplification — v1 awareness comes from Vercel cron logs and the Slate Dashboard's most-recent-week indicator. If cron reliability becomes a concern in practice, alerting can be added without architectural change.

## Vercel-specific notes

Vercel cron pricing is amortised by scheduled cadence — Pro tier (already required per ADR-0008 for the 15-minute odds snapshot) accommodates the Phase 3b crons within existing capacity. Parquet is re-downloaded on each cron invocation (Vercel functions are ephemeral); the working-set parquet at peak (Week 18 cumulative play-by-play) is well under 100 MB, comfortably within function memory and time budgets. Logging is structured `console.log`, viewed in Vercel logs; no separate logging service in v1.
