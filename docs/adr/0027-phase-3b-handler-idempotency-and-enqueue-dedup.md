# Phase 3b idempotency: handler idempotency-by-construction and the enqueue dedup guard

ADR-0026 settled Phase 3b's job taxonomy (`ingest_game` per game, `aggregate_week` per
season-week) and explicitly punted the `jobQueue` DDL to a follow-on migration. That
migration (0002) built the table with only the `job_queue_pending_idx` partial index and
**no** uniqueness guard on the per-job logical key — and that key lives *inside* the
`payload` jsonb (`nflverseGameId` for ingest; `season` + `week` for aggregate), not as a
top-level column. So nothing today stops a re-running discovery from enqueuing duplicate
jobs. This ADR closes that gap — but in doing so reframes it, because the duplicate-job
question turned out to be the *second* of two layers, not the first.

## The reframe: correctness cannot live at the enqueue layer

The instinct is to prevent duplicate *rows* so a unit of work runs once. That instinct is
defeated by Phase 3b's own retry machinery: ADR-0016's stall sweep resets an
`in_progress` job to `pending` and re-runs it after 15 minutes (the crash-after-commit,
before-marking-`completed` case), and exponential backoff re-runs failures. **A single job
row can therefore execute more than once regardless of any enqueue guard** — that second
execution comes from re-running the *same row*, which no dedup of *duplicate rows* can
prevent.

The consequence is decisive: **idempotency-by-construction of both handlers is mandatory,
not optional** — it is already forced by ADR-0016, independent of anything decided here.
Correctness must be secured *underneath* the enqueue layer. So the design splits in two:

- **(A) Handler idempotency-by-construction — the correctness layer. Non-negotiable.**
- **(B) The enqueue dedup guard — a waste/contention optimization layered on top.**

The play table's `UNIQUE(game_id, play_id)` net (the original framing's reason a heavy
dedup mechanism might be unnecessary) is an **(A)-layer, ingest-side** fact. It is real, but
it does not by itself reach `aggregate_week`, and it secures *data*, not *enqueue*. Naming
the two layers separately is what keeps that net from being over-generalized into a false
"we don't need to do anything" conclusion.

## (A) Handler idempotency-by-construction

`ingest_game` is already idempotent modulo confirming **every write in its path is
conflict-tolerant** (`UNIQUE(game_id, play_id)` on `play`, `UNIQUE(game_id, drive_number)`
on `drive`, `nflverseGameId` upsert on `game`). A re-run re-pulls and conflict-aways; no
corruption.

`aggregate_week` is made idempotent by three properties, all of which the re-run sources
above (stall sweep, retry, enqueue duplicate, ADR-0015 cascade re-enqueue) require anyway:

1. **`UNIQUE(teamId, seasonId, week)` on `team_week_stats`** — the linchpin. Already exists
   (`team_week_stats_team_season_week_unique`, written by Phase 3a). A re-run's writes
   serialize on this constraint.
2. **The week's rows written as a single transaction of upserts** (ADR-0008's transactional
   ingestion), so a concurrent or re-run write overwrites with identical values —
   last-writer-wins, harmlessly.
3. **`recordWins` / `recordLosses` / `recordTies` computed as prior-week (N−1, frozen) +
   this week's result read from the `game` table, or recomputed season-to-date — NEVER
   read-own-row-and-increment.** N−1 and the game result are both fixed, so the output is
   deterministic; read-own-and-increment is the *only* non-idempotent realization, and it is
   forbidden. Phase 3a's `compute_record` (`build.py`, cumulative-sum over the schedule) is
   the safe precedent; ADR-0026's "incrementable count … is incremented" wording is the trap
   and is corrected there (see the back-reference note added to ADR-0026).

With (1)–(3), two `aggregate_week` runs for the same `(season, week)` compute identical
values over the same stable data — stable because the completeness gate (ADR-0019)
guarantees the week's plays are settled before aggregate runs — serialize on the unique
constraint, and last-writer-wins with no corruption. The race is **benign by construction**,
not by luck. That is exactly the "idempotent if you squint at the isolation level"
assumption this project writes down rather than leaves implicit.

## (B) The enqueue dedup guard

With (A) underneath, duplicate jobs threaten only **wasted parquet pulls, redundant
recompute, and contention for the tight, unmeasured 300s drain budget** (ADR-0026's
chunking caveat) — never correctness. "Do nothing, let discovery re-pull" is therefore a
legitimate baseline; the guard is justified only by the cost it removes.

**The risk is asymmetric, but the mechanism is uniform.** `ingest_game` targets are
day-partitioned (ADR-0016: Monday discovers Sunday games, Tuesday MNF, Friday TNF), so two
discovery runs do not naturally re-enqueue the same game — overlap is incidental (a
double-fired cron). `aggregate_week(N)` is week-scoped: it is a legitimate discovery target
on *both* Monday and Tuesday (week N is not complete until MNF) **and** it self-perpetuates
via ADR-0026's precondition guard, so without a guard you accumulate multiple concurrent
`aggregate_week(N)` jobs spinning on the same precondition. The *risk* is asymmetric; the
*mechanism* is not. A single **ensure-exists-by-logical-key** enqueue — "insert only if no
`pending`/`in_progress` job exists for this key" — applied uniformly to both types is the
same code path parameterized by the key, **less** code than special-casing aggregate and
bare-inserting ingest, and it covers ingest's incidental double-cron case for free.

Realized as a single atomic `INSERT … WHERE NOT EXISTS (… a pending/in_progress job for this
key …)`.

> **Note (2026-06-19): the ingest-vs-aggregate overlap asymmetry above COLLAPSES under
> [ADR-0028](0028-phase-3b-discovery-completeness-targeting.md)'s day-agnostic targeting — and
> this STRENGTHENS the uniform-guard conclusion.** The asymmetry argument here rested on
> `ingest_game` being "day-partitioned" so its overlap is only incidental. ADR-0028 removes the
> day-partitioning: discovery targets purely on data-completeness state, so an unfrozen game is
> re-targeted *every* run until its `playsFrozenAt` marker is set — structurally identical to
> `aggregate_week` being re-targeted every run until its rows exist. So both types are now the
> same shape: *re-targeted every run until their completeness signal exists, prevented by filter
> (i) (a live job) + filter (ii) (the completeness signal)*. Overlap is prevented by **the
> filters, not the calendar.** The uniform guard is therefore even better justified than the
> asymmetry argument claimed — it no longer needs the asymmetry at all. (ADR-0028 also pins the
> two invariants that make filter (i) a *complete* dedup story: INSERT-only-from-discovery and
> live-scoped ensure-exists.)

### Lifecycle scope: `pending`/`in_progress` only — and the second filter

The guard keys on the **live** lifecycle (`pending`/`in_progress`) only, **never** "a
`completed` job exists." A `completed`-aware guard would silently break ADR-0015's
cascade-delete recovery: after a cascade delete the *old* jobs for those weeks still sit in
the table marked `completed`, and we **deliberately** want to re-enqueue them.

But `pending`/`in_progress`-only *alone* is not the whole story. It governs only whether to
add a *second live job for work already in flight*. It does **not** answer "should discovery
target this unit at all?" — and a pending-only guard, asked that, would re-enqueue every
already-completed game forever. So there are **two filters**, and they must not be conflated:

- **Filter (i) — the dedup guard (this ADR).** Skip enqueue if a `pending`/`in_progress`
  job already exists for the key. Prevents piling a second live job on in-flight work.
- **Filter (ii) — discovery's "needs work?" targeting (principle here, mechanism deferred).**
  Whether a unit belongs in discovery's target set at all **keys off data-completeness
  state, never off job-`completed` status.** This is what makes cascade-delete transparent:
  the delete removes the *data*, which re-exposes the unit to discovery's target set
  naturally, while the stale `completed` job row stays correctly irrelevant to targeting.

### Discovery scope: introduce new work, do not resweep

The two filters resolve discovery's scope: discovery **introduces new expected work over the
active window and self-heals** (ensures every expected, not-yet-complete unit has a live
job); it does **not** blind-resweep already-targeted work, because ADR-0016's per-job
retry/backoff already chases not-yet-complete work by re-running the *same* row. A catch-up
resweep would duplicate that retry mechanism. A permanently-incomplete game fails out at 5
attempts → human attention (ADR-0016). With this, `ingest_game` has no *structural*
duplication — each game once, on its day, retries self-contained — confirming the asymmetry
above. (**The "each game once, on its day" / asymmetry framing is retracted by
[ADR-0028](0028-phase-3b-discovery-completeness-targeting.md)** — discovery targets
day-agnostically on data-completeness state, so an unfrozen game *is* re-targeted every run,
prevented from duplicating by the filters, not the calendar; see the §B note above. The
no-blind-resweep conclusion itself stands; only the day-partitioning rationale for it does not.)

## Why no index

The guard's `WHERE NOT EXISTS` filters `job_queue` to the live set on a jsonb path
(`payload->>'nflverseGameId'`, or `payload->>'season'` + `payload->>'week'`). We add **no
index** — not the rejected jsonb expression index, not a broadened partial index.

The honest reason is **not** "only ~17 rows exist." The `pending`/`in_progress` *subset* is
one week's work (≤ ~16 ingests + 1 aggregate, plus a few not-yet-swept stalled rows), but
the **table** accumulates `completed` rows across the season(s) under the status model's
retention, and the existing `job_queue_pending_idx` covers `status = 'pending'` only — not
`in_progress` — so the `status IN ('pending','in_progress')` predicate is not fully
index-served. The guard is a **small-table scan filtered to the live set**: milliseconds at
v1 volume, run ~17 times per discovery. The cheapness rests on the table **staying small**,
which depends on `completed`-job retention.

Recorded escape hatches, in order: a v1 lets `completed` rows accumulate (cheap for years);
if enqueue ever slows, **prune/archive old `completed` rows**, or broaden the partial index
to `WHERE status IN ('pending','in_progress')`. An **expression index on the jsonb path
stays premature** — the same reason the DB-constraint alternative below is rejected.

## Racy by design

`INSERT … WHERE NOT EXISTS` is **not** concurrency-safe in Postgres: `NOT EXISTS` takes no
predicate lock on the absent rows, so two truly-concurrent discovery runs can both pass it
and both insert. This is **accepted, not overlooked.** The structural/temporal duplication
the guard exists to kill (Monday's `aggregate_week(N)` vs Tuesday's) is **24h apart**, so a
plain existence check catches it reliably; only a rare same-instant double-fire leaks
through, and **(A) makes that leak harmless** — identical recompute over stable data,
serialized on the unique constraint.

This guard prevents *structural/temporal* duplication, **not** *concurrent* duplication.
**Correctness against concurrent re-execution lives in (A), not here.** A future reader must
not read `WHERE NOT EXISTS` as a uniqueness guarantee and delete (A) believing the guard
covers it — and, symmetrically, must not delete this guard believing (A) made it free: (A)
secures correctness, (B) removes the waste (A) would otherwise tolerate. **The (A)↔(B)
dependency is bidirectional** and is noted in both directions so neither can be removed
without the other's note surfacing.

### Rejected: the airtight jsonb partial-unique index

A `UNIQUE` *partial expression index* on `payload->>'…' WHERE status IN
('pending','in_progress')` would be airtight against the concurrent case. Rejected as a
deliberate cost/benefit call, not an oversight: it buys only the rare same-instant double-
fire (which (A) already neutralizes) at real, lasting schema cost — an expression index over
a jsonb path with a predicate on the **mutable** `status` column. It converges on exactly
the same observable semantics as the app-check (occupied while live, freed on `completed` →
cascade re-enqueue allowed), so it pays more for the same behavior plus a rare edge that does
not threaten correctness. Recorded so it is not re-proposed.

## Cut line — what the discovery grill inherits

This ADR closes **filter (i)** (the uniform `pending`/`in_progress` ensure-exists guard) and
the **principle** of **filter (ii)** (targeting keys off data-completeness state, never job-
`completed` status). It deliberately does **not** close filter (ii)'s **mechanism** — how
discovery *cheaply reads* completeness — which is a real decision with its own trade-offs
(live re-check vs materialized flag vs row-presence: cost / staleness / write-coupling) and
belongs to the discovery grill viewed whole.

The discovery grill **inherits filter (ii)'s principle as a decided constraint** — it starts
from "key off data-state, now pick the mechanism," not a blank slate — and inherits two open
questions plus one seed:

- **`aggregate_week` completeness is checkable by *output presence*:** `teamWeekStats` rows
  exist for `(season, week)` → done. Clean.
- **`ingest_game` completeness is *not* symmetric:** play rows can exist for a game that
  **failed** its gate, so play-presence ≠ gate-passed. `ingest_game` therefore likely owes a
  **gate-passed completeness signal**, emitted by the handler on gate pass, which becomes
  filter (ii)'s read for ingest. Column-on-`game` vs derived is the discovery grill's call —
  but flag that this handler probably owes that marker, since it is the coupling point
  between `ingest_game` and discovery's targeting.

## Cross-references

- ADR-0026 — Phase 3b unit of work; this ADR closes the enqueue-dedup gap it left and
  corrects its record-column wording (see the note added there).
- ADR-0016 — cron trigger, drain query, retry/backoff, the 15-minute stall sweep that forces
  handler idempotency.
- ADR-0019 — write-once + the completeness gate that guarantees stable plays before
  `aggregate_week` runs.
- ADR-0015 — cascade-delete re-run; transparent to filter (i) because filter (ii) keys off
  data state.
- ADR-0008 — transactional ingestion; the 300s budget the guard protects.
