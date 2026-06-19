# Phase 3b — Implementation Kickoff Brief

## What this session does

Implement the Phase 3b **forward-cron ingestion pipeline**: the discovery enumerator, the two
job handlers (`ingest_game`, `aggregate_week`), the drain mechanics, the typed enqueue layer,
and the cron wiring.

The design is **complete and frozen** across ADRs **0016, 0019, 0026, 0027, 0028**. This
session builds to that spec — it does **not** re-open it. Unlike the advisory session that
produced these ADRs (which worked without repo access, by relay), **you have full repo
access**; the ADRs and the code are your ground truth.

If implementation surfaces a _genuine_ gap or a contradiction with an ADR, **stop and surface
it** rather than silently redesigning. The ADRs encode hard-won decisions, and most "obvious
simplifications" here are re-introducing a trap the ADRs deliberately closed (see the traps
section).

---

## Read first — the spec, in this order

1. **ADR-0028** — discovery: completeness-state targeting, the `playsFrozenAt` marker, the
   active window, the enqueue assembly, the two paired invariants, and the relocated
   `aggregate_week` precondition. This is the newest ADR and the one that ties the others
   together — start here.
2. **ADR-0027** — handler idempotency-by-construction **(A)** + the enqueue dedup guard
   **(B)**; filters **(i)** (dedup) and **(ii)** (data-state targeting). Read the (A)↔(B)
   bidirectional-coupling discipline; it recurs.
3. **ADR-0026** — the two-tier unit of work; schedule-as-denominator; recompute-not-carry;
   the carry-forward production rule. **Its Precondition section and one Discovery line are
   amended by 0028** — read the dated amend-notes in place, not just the body.
4. **ADR-0019** — write-once forward ingestion + the per-game completeness gate (score
   reconciliation + the play-count floor). This gate is what `playsFrozenAt` records the pass
   of.
5. **ADR-0016** — cron cadence (Mon/Tue/Fri + drain windows), the drain query
   (`FOR UPDATE SKIP LOCKED`), retry/backoff, the 15-minute stall sweep. **Its failure model
   is refined by 0028 §3** — read that amend-note.

**Code ground truth to read alongside the ADRs:**

- `db/schema.ts` — current schema (the `play` / `drive` / `job_queue` tables from migration
  0002; `game.playsFrozenAt` from 0003).
- `drizzle/0002_*.sql` and `drizzle/0003_*.sql` — the staged migrations.
- `docs/parquet-mapping.md` — the nflverse-parquet → column mapping (including where the
  in-progress score lives: `total_home_score` / `total_away_score`, in the **pbp parquet**,
  not the schedule).
- `data/teams.ts` — the 32 canonical team abbreviations (the exact-match target for
  abbr → `team_id` resolution).
- **Phase 3a scripts (`build.py`, `elo.py`)** — the **algorithmic precedent you must
  reproduce** for `record`, ELO advancement, the EPA-per-play columns, and `sosRank`. Phase 3b
  continues Phase 3a's chain (the 2026 Week-0 ELO baseline), so any divergence breaks
  forward continuity.

---

## Build order

1. **Apply migrations 0002 then 0003.** Neither is applied to any database (dev or prod) yet —
   `drive` / `play` / `job_queue` do not exist in the DB, and `game.playsFrozenAt` is not on the
   live `game` table. 0002 creates the three tables; 0003 adds the marker column. Apply both (in
   order) before writing any handler/enumerator code, since everything below reads them.
2. **Job-queue types + the typed enqueue helper.** The `jobType` payload as a **discriminated
   union** narrowed once at drain time (each handler receives a typed payload, never raw
   jsonb — ADR-0026). The **ensure-exists guard**: `INSERT … WHERE NOT EXISTS (a
pending/in_progress job for this logical key)`, keyed on `nflverseGameId` (ingest) or
   `season`+`week` (aggregate).
3. **Discovery enumerator** (ADR-0028 §5 assembly). Derive current week N from the schedule;
   window `{N-1, N}`, season-floored; read the **schedule file only** (not pbp). `ingest_game`
   targets = scored games **minus** games with `playsFrozenAt IS NOT NULL`. `aggregate_week`
   target = `NOT EXISTS teamWeekStats(S,W)` **AND** all of W's scheduled games frozen.
4. **`ingest_game` handler.** Create the `game` row (final score from schedule) → write
   plays/drives (abbr → `team_id` resolved, loud-fail on unknown) → run the completeness gate
   (ADR-0019) → on pass, set `playsFrozenAt` **last** (`COALESCE`) and mark `completed`. Assert
   score-present on entry.
5. **`aggregate_week` handler.** Assert all-of-W's-games-frozen → read prior-week `eloRating`,
   recompute the cumulative columns season-to-date from `play`/`game`, compute `sosRank`,
   advance `record` (prior + result) → **single-transaction** upsert of the week's rows
   (including carry-forward) → assert row-count `32/14/8/4/2` before commit.
6. **Drain mechanics.** `FOR UPDATE SKIP LOCKED`; the 300s budget loop; the 15-minute stall
   sweep (`in_progress` → `pending`); retry/backoff (1/2/4/8/16h, 5 attempts → `failed`).
   Handlers **UPDATE their own row** on retry — never INSERT.
7. **Cron wiring.** `vercel.json` (Mon/Tue/Fri + drain windows per ADR-0016); the route +
   `HANDLERS` dispatch map.

---

## The intuitive-but-wrong traps

These are the places a from-scratch implementer drifts **even with the ADRs open**, because the
wrong choice is the intuitive one. Each ADR guards these; this is the consolidated watch-list.

1. **`record` — never read-own-row-and-increment.**
   WRONG: read this team's running record and add this week's result.
   RIGHT: compute as **prior-week (N-1, frozen) record + this week's result** read from the
   `game` table (or recompute season-to-date).
   WHY: read-own-and-increment is the _one_ non-idempotent realization — a stall-sweep or
   retry re-run double-counts. (ADR-0026 record bullet; ADR-0027 (A) property 3.)

2. **`playsFrozenAt` — set on gate-PASS, last, not on play-write.**
   WRONG: set the marker when plays are written.
   RIGHT: set it as the **last step, only on completeness-gate pass**:
   `UPDATE game SET plays_frozen_at = COALESCE(plays_frozen_at, now()) WHERE …`.
   WHY: a failed gate commits **partial plays**, so play-presence ≠ gate-passed. The marker is
   the gate-pass signal filter (ii) reads; setting it on play-write reintroduces the exact hole
   the column exists to close. (ADR-0028 §1.)

3. **Handlers ASSERT preconditions; they never wait or re-enqueue.**
   WRONG: handler backs off / re-enqueues when its precondition isn't met (ingest waiting for a
   score; aggregate waiting for the week to complete).
   RIGHT: discovery only enqueues when the precondition holds; the handler **asserts** it and
   **loud-fails** on violation (a discovery-contract breach or a mid-flight cascade).
   WHY: all waiting lives in discovery's enumeration. A handler-runtime precondition + backoff
   collides with the 5-attempt cap — the bug 0028 §5 dissolved by relocating the aggregate
   precondition to the enqueue gate. **Do not build the `COUNT(complete)==expected` runtime
   guard that ADR-0026's _pre-amendment_ text describes** — read its amend-note. (ADR-0028
   §4–§5.)

4. **Discovery targets DATA-state, never JOB-status.**
   WRONG: "skip if a `failed`/`completed` job exists for this unit."
   RIGHT: target purely on data-completeness — `playsFrozenAt IS NULL` (ingest),
   `NOT EXISTS teamWeekStats(S,W)` (aggregate).
   WHY: reading `completed`-status breaks cascade-transparency; reading `failed`-status _also_
   reintroduces cascade-staleness **and** defeats the bounded-window retry model. (ADR-0028 §3;
   ADR-0027 filter (ii).)

5. **The two paired invariants — break either and filter (i) leaks.**
   (a) **INSERT-only-from-discovery:** handlers UPDATE their own row on retry, never INSERT a
   new one; the only INSERTers are discovery and the manual runbook.
   (b) **LIVE-scoped ensure-exists:** the guard skips only on a `pending`/`in_progress` job —
   **never** any-row-including-`failed` (tighten it to any-row and you break the failed-game
   re-mint).
   WHY: together they make filter (i) a _complete_ dedup story. (ADR-0028 §5.)

6. **`aggregate_week` write: recompute, single-transaction, row-count asserted.**
   - **Recompute** cumulative columns season-to-date; **never carry deltas** —
     `teamWeekStats` stores means/rates, not the running sums a carry would need (ADR-0026).
   - Write the week's rows in a **single transaction** — that atomicity is what discovery's
     bare-existence read depends on (ADR-0028 §2). If you split it into per-row upserts, the
     existence read silently reads "done" on an incomplete week.
   - **Carry-forward** by `gameType`: regular = all 32 unconditional; playoff = played teams +
     wild-card-week #1-seed byes only, eliminated teams absent (ADR-0021).
   - **Assert** row count == `32/14/8/4/2` (weeks 0–18 / 19 / 20 / 21 / 22) before commit.

7. **Score-availability = schedule finality; discovery never reads pbp.**
   Schedule **score-presence IS finality** (`home_score` & `away_score` not-null — the repo's
   existing "game was played" filter). Discovery enumerates on it. The in-progress score lives
   in the **pbp parquet**, which discovery must not read; that quarantine is what makes
   schedule-only discovery churn-free. (ADR-0028 §4.)

8. **Team resolution — exact-match, loud-fail.**
   Resolve `posteam`/`defteam` abbreviations to `team_id` FKs **at ingest**, exact-match
   against `data/teams.ts`, and **loud-fail on an unknown abbreviation**. No alias map exists;
   for 2026-forward, exact-match is correct, and a silent miss would corrupt attribution.
   (migration 0002 / `parquet-mapping.md`.)

9. **Data conventions to mirror from Phase 3a.**
   `timeOfPossession` = integer **seconds**; **points** from `game` final scores, **yards**
   from `play` rows (matches `build.py`); `play` carries `season`/`week`/`posteam`/`defteam`/
   `game_id` (ADR-0018).

---

## Deferred to the first live ingestion week — don't solve now, but know they're coming

- **Drain chunk sizing.** Plays-per-game (~150–180 est., **unmeasured** — `play` is
  greenfield) → validate against real volume to size how many `ingest_game` jobs fit one 300s
  drain window (ADR-0026 caveat).
- **Per-game pbp read strategy.** v1 lean: pull the season parquet, filter to `game_id` in
  memory (<100 MB). Predicate-pushdown on `game_id` is the optimization to reach for _if_ the
  300s budget tightens _and_ the parquet's row-group ordering would actually let pushdown skip
  row groups — **both unconfirmed**, deferred.
- **Playoff-schedule-publication check** (ADR-0026 pre-registered). Confirm nflverse exposes
  each round's real matchups promptly enough that discovery picks them up before that round's
  drain window opens.
- **2026-postseason matchup-exposure check** (ADR-0028 pre-registered) — the live version of
  the above on the first real playoffs.
- **Completeness-gate thresholds** — the score-reconciliation tolerance and the play-count
  floor value: tune on the first live week (ADR-0019).

---

## Out of scope

- **Dashboard scheduled-row preload** — explicitly out (ADR-0026).
- **Dashboard split indexes** — deferred to later slices (6–9).
- **Applying migrations 0002 / 0003 to Neon _prod_** — a separate, deliberate deploy step. (The
  dev/working-DB apply is step 1, so you can build and test against the tables; promoting to prod
  is the deploy, not part of the build.)
- **Ship-criterion hand-verification** (≥3 games re-derived to confirm forward ELO/`sosRank`
  continuity with Phase 3a) — a validation step that follows a working pipeline, not a build
  task.

---

## Verify as you go

- `npx tsc --noEmit` clean after each meaningful change (the project values type safety; the
  discriminated-union payload is where it pays off most).
- Match repo conventions: drizzle `casing: "snake_case"`, `DATABASE_URL` in `.env.local`.
- Migrations are **written, not applied** in this repo's workflow until the code that uses them
  lands; apply **0002 then 0003** to your working DB first (step 1), since the enumerator and
  handlers read those tables and the marker column.
- **Don't commit unless asked.** Leave the working tree for review.
