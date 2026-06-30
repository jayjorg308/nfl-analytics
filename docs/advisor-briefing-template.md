# Advisor briefing — NFL Analytics, Slice 4

> **Purpose of this document.** You are an architecture advisor in a separate chat
> that cannot see the repo. This briefing is your only ground truth. It was written
> by the codebase agent with every specific claim (file paths, ADR numbers, schema
> details) verified against the actual files. If you find yourself recalling a
> specific fact not in this document — a filename, an ADR number, an exact value —
> treat that as a claim to verify (see §6), not something to assert. Your
> architectural reasoning is trusted; your specific recall is not, and degrades over
> a long conversation.
>
> **Reusing this briefing.** §§1–4 and §7 are phase-specific — the current state and the
> opening design question — so refresh them for the new session's topic. §§5–6 (working
> patterns and the three-party model) are durable and carry across sessions unchanged.

---

## 1. What the project is

A personal NFL analytics web app for the author and a small friend group — it
replaces a multi-tab Google Sheet they used to prep weekly betting picks and
game-watching notes. It surfaces EPA-based matchup edges, in-house ELO ratings,
strength-of-schedule, and (later) prop research, via a guided weekly workflow
(slate → game → player → prop).

The load-bearing framing (ADR-0025): **v1 is the working tool for the friend group.**
The portfolio/research-publication dimension is real and intended but is the
**post-v1 sandbox the tool enables**, not a gate on shipping. So Slice 4 is judged
by whether it reliably lights up the Player Page for the friend group's weekly
workflow, not by whether it produces something publishable.

## 2. Current state — what's shipped, what's next

Slice numbering follows ADR-0010's post-grilling "engine-work split."

- **Slice 1 — done, deployed to Vercel.** Postgres schema (Neon), the `week_summary`
  read-view, hand-seeded sample data (since removed), three-tier Clerk auth
  (public / friend-gated / admin), and a Slate Dashboard skeleton.
- **Slice 3 — team-level ingestion + MOV-ELO — ✅ COMPLETE, live on prod (~2026-06-29).**
  Two phases, both shipped:
  - **Phase 3a (historical backfill)** — a local one-shot Python script
    (`scripts/backfill/`, run from the author's laptop against prod, _not_ deployed)
    computed 2021–2025 plus the **2026 Week-0 ELO baseline**. Prod row counts (verified
    21/0 by `scripts/verify-phase3a.mjs`): **6 seasons, 1424 games, 3212 `teamWeekStats`
    rows.**
  - **Phase 3b (forward weekly cron) — built + deployed.** The full pipeline is in
    `lib/ingestion/` + `app/api/cron/` (inventory in §4), validated against Phase 3a's
    Python as an independent source of truth — **machine epsilon on regular weeks
    (1.11e-16), exact on playoff weeks**. Migrations `0002`/`0003` applied to dev and prod.
    Crons live on **Vercel Pro**, **dormant until the 2026 season** (§4). The bundled
    MOV-ELO methodology publication was cut (ADR-0010 2026-06-18 / ADR-0025), so Phase 3b
    shipping _is_ Slice 3 complete.
- **Slice 4 — player-level ingestion + denormalised opponent-rank fields → Player Page —
  NEXT. This session designs it (§7).**
- **Later:** Slice 5 (The Odds API → betting-line columns), Slices 6–9 (the page slices:
  Game Detail, Player, Props, Team + Team Leaderboard).

_(There is no active "Slice 2" — the numbering jumped after the Slice-3 grilling re-split
the original engine block. Slice 1 is the only slice shipped before Slice 3. Low-confidence
on the historical reason; it does not matter for Slice 4.)_

**What the team-level pipeline hands to Slice 4 (in-season):** Phase 3b is **wired to write
`teamWeekStats` rows weekly** but is **dormant in the offseason** (a verified no-op until ~Sept;
§4). The present-tense facts: `teamWeekStats` holds Phase 3a's 2021–2025 rows **plus the 2026
Week-0 baseline** (mean exactly 1500.0 by construction); nothing has consumed that baseline yet —
its **first consumption is `aggregate_week` for 2026 Week 1**, in September. Slice 4 is the
**first consumer of a Phase-3b output** — its opponent-defensive-rank fields **will** denormalise
against those weekly team-week rows once they're being written (§7).

## 3. What Phase 3b is — the build ahead

Phase 3b is the **forward, automated weekly ingestion pipeline**: every week during
the season, pull the latest nflverse play-by-play, and write the new week's
`game` / `drive` / `play` / `teamWeekStats` rows from 2026 Week 1 onward. It runs as
Vercel cron functions sharing the Next.js deployment. **Nine ADRs touch Phase 3b:** two
foundational — **ADR-0008** (ingestion runtime / the Python boundary) and **ADR-0018**
(which play columns become Postgres columns); five specifying the pipeline's behavior
end-to-end — **ADR-0016** (cron / retry), **ADR-0019** (write-once + completeness gate),
**ADR-0026** (two-tier unit of work), **ADR-0027** (handler idempotency + enqueue dedup),
**ADR-0028** (discovery); and two added _during the build_ — **ADR-0029** (parquet reader,
amends 0008) and **ADR-0030** (cron auth + wiring, amends 0016). Each is summarized below in
my words — the full ADRs can be pulled into the conversation if you need the exact wording:

**ADR-0008 — ingestion runtime and the Python boundary.**
Production ingestion runs in **Vercel cron functions** (same deployment as the app —
one auth boundary, one log stream), _not_ a separate worker service. The
TypeScript/Python gap is bridged by **reading nflverse parquet releases directly in
Node** — via **`hyparquet`** (**ADR-0029** amends ADR-0008's provisional
`apache-arrow` / `parquetjs` naming; `hyparquet` reads both the schedule and the pbp from
the nflverse-data release parquet over HTTP) — no Python in production. (Python exists only
in the local backfill script, which is never deployed.)

The nflverse play-by-play release is **one season-level parquet, cumulative, revised in
place** — not per-week artifacts. nflverse overwrites the rolling file as the season
progresses (ADR-0019: the provisional release is gone once overwritten — the reason
write-once + the pre-registered re-pull validation exist), and the working-set file at
its Week-18 peak is well under 100 MB, re-downloaded on each cron invocation (ADR-0016).
Phase 3a's backfill reads it one season at a time (`scripts/backfill/aggregate.py`, via
`nfl.import_pbp_data([year], …)`). **Consequence for Phase 3b:** the parquet pull is
**per-cron-run on the drain path, not per-job** — the season file is pulled once per
draining invocation and the per-game jobs read game-scoped slices from it, so
game-granularity does not multiply downloads. (ADR-0028 refines this: **discovery itself is
schedule-only** and does not pull the heavy pbp parquet at all — it reads only the light
schedule file; the pbp pull lives on the drain/handler side.)

Heavy weekly jobs that might exceed Vercel's **300s function timeout** are
**chunked through a `jobQueue` Postgres table**: each pending row is a unit of work;
each cron invocation drains as many as fit in its window; the next invocation resumes.
Crash-safe by construction. Documented fallback if parquet-in-Node hits friction: a
GitHub Action running Python for ingestion while the app stays pure TS — the escape
hatch, not the plan.

**ADR-0016 — cron trigger timing and retry.**
Amends an earlier "~30 min after each game" trigger (ADR-0006), which was wrong because
nflverse parquet doesn't exist that soon. The durable commitment is **ADR-0006's
freshness contract** — _by Monday morning, every Sunday game's stats/EPA/ELO are
integrated_ — and trigger timing is just implementation. Two cron entries, both
dispatching through one `HANDLERS` map:

- **Primary scheduled cron:** Mon/Tue/Fri at **10:00 UTC** (~5–6am ET, aligned to
  nflverse's daily release, not game-end). Monday = Sunday games, Tuesday = MNF,
  Friday = TNF. Each run discovers the day's expected work, processes available
  parquet, and enqueues a `jobQueue` retry (`not_before` ≈ 1h out) for anything not
  yet released.
- **Drain cron:** every 30 min during **active ingestion windows** (Sun 23:00 UTC →
  Tue 18:00 UTC, and Thu 23:00 UTC → Fri 18:00 UTC). Runs the drain query
  (`status='pending' AND (not_before IS NULL OR not_before <= now()) ... FOR UPDATE
SKIP LOCKED`) regardless of "expected work."
- **Retry:** exponential backoff, **5 attempts** (1h, 2h, 4h, 8h, 16h → mark
  `failed`), ~31h total — past that it's an upstream problem for a human, not more
  retries. Stalled jobs (`in_progress` > 15 min = crashed handler / timeout) are
  reset to `pending` with `retryCount` incremented at the start of each drain run.
- Active alerting (email/Slack) is deferred to v2; v1 awareness = Vercel logs + the
  dashboard's most-recent-week indicator.

**ADR-0018 — which play-by-play columns become Postgres columns.**
The `play` table is greenfield (Phase 3b creates it). nflverse play-by-play has ~370
columns; this ADR is the _principle_ for which earn a column (the concrete list lands
in `docs/parquet-mapping.md` at build time). Two-consumer split: the **Postgres `play`
table is the online serving layer** for read-time splits (directional/situational
breakdowns); the **durable parquet is the research/backfill layer** for everything
else. A column earns a Postgres slot if it passes **one** of: the **Descriptor test**
(a revision-stable descriptor of what happened — participants, location, down/distance,
formation/tempo/pressure — that a plausible split would filter/group by, read at
natural breadth) or the **Volatility test** (a non-reconstructable _base_ model output
that drifts across nflverse pipeline runs, so capturing it at ingestion buys
row-internal consistency a later backfill can't reproduce — base set: `epa`, `air_epa`,
`wpa`, `cpoe`, `xpass`, `pass_oe`). Derivable rollups and model companions are
excluded (reachable via parquet). Meta-rule: the cut is **cheaply reversible both ways**
(`ADD COLUMN` + backfill, or `DROP COLUMN`), so make the principled cut and move on.

**ADR-0019 — write-once forward ingestion + the completeness gate.** (Amends ADR-0016.)
nflverse _revises_ play-by-play after first release. Phase 3b is **write-once**: ingest
each week from its first _complete_ parquet release and **never revisit** — model
outputs are frozen at first-complete-release values. (Rejected: settle-window — it would
re-pull settled values later, which is exactly the late re-pull that drains ADR-0018's
Volatility test of its justification; and re-ingest-indefinitely — makes dashboard EPA
non-deterministic.) Write-once's one failure mode — freezing a release that's _present
but incomplete_ — is closed by the **completeness gate**:

- **Primary check — score reconciliation:** sum each team's scoring-play points from
  the ingested plays and compare to the final score already on the `game` row. A
  mismatch means plays are missing. A true invariant, not a heuristic.
- **Secondary:** every `final` game has play rows; a per-game play-count floor (~100,
  tuned at build).
- A failed gate **re-enqueues through ADR-0016's existing `not_before`/backoff path** —
  _one retry mechanism, two triggers_ (non-arrival vs. partial-arrival). No new
  machinery.
- A **2026 forward validation is pre-registered**: during the first live weeks,
  archive a provisional Monday parquet, re-pull the same weeks ~2 weeks later, diff
  cumulative season-to-date team EPA/play. Small delta (< ~0.01) confirms write-once;
  a large delta reopens _timing only_ (wait for a more-settled release), never
  settle-window.

**ADR-0026 — the two-tier unit of work + per-week aggregation.**
Phase 3b's work splits along its **one genuine dependency boundary** — _all of a week's
games must be ingested before that week's cross-team aggregate_ — into exactly two job
types, nothing finer:

- **`ingest_game`** (one per game, keyed by `nflverseGameId`): reads the game's plays from
  the season parquet, writes its `game` / `drive` / `play` rows, runs the completeness gate.
- **`aggregate_week`** (one per `(season, week)`): advances the ELO chain from the prior
  week's row, **recomputes** the season-to-date EPA columns and traditional per-game
  aggregates from `play` / `game`, computes the cross-team `sosRank`, advances the record,
  and writes the week's `teamWeekStats` rows (including bye carry-forwards, per ADR-0021).

There is **no `depends_on` column and no dependency engine** — the queue stays a flat drain;
the dependency is enforced by a precondition (relocated to discovery's enqueue gate by
ADR-0028 — see below). The **"expected games for week N" denominator** is sourced from the
schedule and **snapshotted into the `aggregate_week` payload** at enqueue. Cumulative columns
are **recomputed from source each week, not carried** (drift-free, cascade-robust, no schema
change); the record is computed as **prior-week + this week's result, never
read-own-and-increment** (load-bearing for idempotency — see ADR-0027). The payload is typed
at the TS boundary as a **discriminated union on `jobType`**, narrowed once at drain.

**ADR-0027 — handler idempotency-by-construction + the enqueue dedup guard.**
Reframes "prevent duplicate jobs" into **two layers**, because ADR-0016's stall sweep re-runs
the _same_ job row regardless of any enqueue guard — so correctness must live _underneath_ the
queue:

- **(A) Handler idempotency is mandatory.** `ingest_game` is idempotent because every write is
  conflict-tolerant (`UNIQUE(game_id, play_id)`, `UNIQUE(game_id, drive_number)`,
  `nflverseGameId` upsert). `aggregate_week` is idempotent via the `teamWeekStats` unique
  constraint + the **atomic single-transaction week-write** + record-as-prior-plus-result
  (never read-own-and-increment).
- **(B) The enqueue dedup guard** is a waste/contention optimization on top: a uniform
  **ensure-exists** insert (`INSERT … WHERE NOT EXISTS`) keyed on the per-job logical key,
  scoped to **`pending`/`in_progress` only** — never `completed`, which would break ADR-0015's
  cascade re-enqueue. Deliberately **no uniqueness index** on the logical key (the cost/benefit
  is argued in the ADR); racy-by-design (no predicate lock), but (A) makes the rare concurrent
  leak harmless.

It names **two filters that must never be conflated** — **(i)** the dedup guard (this ADR) and
**(ii)** discovery's "does this unit need work?" targeting, which keys off
**data-completeness state, never job-`completed` status.** Filter (ii) is the principle that
makes cascade-delete transparent; ADR-0027 settled its principle and handed its _mechanism_ to
ADR-0028.

**ADR-0028 — discovery: completeness-state targeting, the marker, the active window.**
Closes filter (ii)'s mechanism and discovery's orchestration. Five decisions:

1. **`ingest_game`'s completeness signal = `game.playsFrozenAt`** — a **set-once nullable
   timestamp** written as the _last_ step of the handler **on gate pass**. Play rows can exist
   for a game that _failed_ its gate, so play-presence ≠ gate-passed — the read keys off this
   marker, not play rows. It carries the write-once **freeze-point** (the only honest
   provenance — nflverse overwrites the rolling parquet in place, so no source-version exists)
   and **dies with the `game` row** on a cascade-delete, re-exposing the unit to discovery for
   free. Orthogonal to `game.status` (real-world state: a game can be `final` with plays
   incomplete — the write-once hole).
2. **`aggregate_week`'s completeness = bare existence** of `teamWeekStats(S,W)` — sound _only
   because_ the week-write is atomic (coupling documented both ways). The row-count expectation
   (32/14/8/4/2) stays the **handler's** post-condition, not discovery's.
3. **Active window = current + one prior week**, **season-floored**. Bound by **retry
   semantics, not cost** (filter (ii) is cheap): a too-wide window would silently resurrect
   genuinely-failed games forever. **Pure data-state targeting, never job-status** — reading
   `failed`-status to skip would reintroduce cascade-staleness. ADR-0016's failure model is
   **refined**: `failed` is **per-job-lineage** terminal, not per-game; game-level terminality
   comes from the window + observability.
4. **Day-agnostic targeting.** The Mon/Tue/Fri cadence is a **parquet-availability** schedule,
   not a game-**partitioning** one (dissolves flex / Saturday / international edge cases).
   Discovery owns **score-availability by enumeration** (the schedule carries only the final
   score, null until complete, so **schedule score-presence == finality**); the handler owns
   **plays-completeness by the gate** (+ a score-present assertion). **Discovery is
   schedule-only.**
5. **Two paired invariants** make filter (i) a _complete_ dedup story —
   **INSERT-only-from-discovery** (handler retries UPDATE their own row, never INSERT) and
   **live-scoped ensure-exists** (gate on `pending`/`in_progress`, never any-row-incl-`failed`).
   And the **`aggregate_week` precondition is relocated from handler-runtime to discovery's
   enqueue gate** — aggregate is enqueued **only once all of the week's games are frozen**
   (this **amends ADR-0026**, dissolving a 5-attempt-cap-vs-precondition collision).

**ADR-0029 — production parquet reader (amends ADR-0008).**
Standardizes on **`hyparquet`** for both the schedule and the pbp, read from the nflverse-data
release parquet over HTTP; supersedes ADR-0008's `apache-arrow` / `parquetjs` naming. Rationale:
the ADR-0013 spike already validated `hyparquet`, `parquetjs` is effectively unmaintained, and
pbp is parquet-only so one library is the lowest-surface-area choice. The schedule read is
column-filtered; the per-game pbp read is the v1-lean "pull the season parquet, filter to
`game_id` in memory" (row-group predicate pushdown deferred until/unless the 300s budget
tightens). ET→UTC kickoff conversion uses the IANA tz database (Intl), not a hardcoded month
cutoff.

**ADR-0030 — cron auth + route wiring (amends ADR-0016).**
The two cron routes are **allowlisted in `proxy.ts`** so Clerk's `protect()` does not redirect
the cron's GET to `/sign-in` — a `3xx` Vercel reads as success, which would make an
un-allowlisted cron a **silent no-op**. The real gate is an in-route **fail-closed
`CRON_SECRET`** check (`verifyCron`); the middleware stays single-purpose. Routes declare
`runtime = "nodejs"`, `maxDuration = 300` (**coupled to** `drain.ts`'s `DRAIN_BUDGET_MS =
300_000`), `dynamic = "force-dynamic"`. `vercel.json` schedules anchor to ADR-0016's windows.
**Requires Vercel Pro** (Hobby caps cron frequency at once/day and function duration at ~60s —
surfaced as a deploy failure, resolved by upgrading). Carries the prod-sequencing checklist:
migrate `0002`/`0003` → set `CRON_SECRET` in prod → _then_ deploy (crons go live on deploy).

## 4. Existing infrastructure — what Slice 4 inherits

The team-level pipeline (Phase 3b) is **built, deployed, and proven**. Slice 4 is not starting
from scratch — it inherits a working ingestion machine and forward play data. (Specific recall
still matters most here: exact column / file / ADR names are claims to confirm against the repo
— §6.)

**Schema + migrations — applied.** `db/schema.ts` defines **seven tables** — `season`, `team`,
`game`, `team_week_stats`, `drive`, `play`, `job_queue` — and the `week_summary` view.
Migrations `0000`–`0003` are **all applied to dev and prod** (`0002` created `drive` / `play` /
`job_queue` + the `job_type` / `job_status` enums; `0003` added `game.plays_frozen_at`). Prod
verified post-migration: the marker column present, `drizzle.__drizzle_migrations` shows **4**,
data intact (**1424 games / 3212 `teamWeekStats`**). The **`player*` tables Slice 4 needs do NOT
exist yet** — they are this slice's first schema work.

**`play` / `drive` are EMPTY in every database right now — only the _schema_ exists.** Phase 3a
never wrote them (team-level only, ADR-0015's forward-only boundary), and Phase 3b is a verified
no-op until ~Sept, so both tables **populate from 2026 Week 1 onward**. Slice 4 therefore designs
against an **empty forward table** — the same offseason situation §7 describes. What exists _now_
is the column shape, not rows: crucially, the **`play` schema already has the participant
columns** — `rusherPlayerId` / `Name`, `receiverPlayerId` / `Name`, `passerPlayerId` / `Name` as
**nullable TEXT, no FK** — defined for Phase 3b's ingestion path per **ADR-0018**, which
explicitly deferred the `player` table + the text→`player_id` resolution to Slice 4. So the
columns are **in place now**; player identity **starts landing in 2026 Week 1**, and Slice 4 adds
the `player` table, the FK, and the resolution. `play`'s schema also carries denormalised
`seasonId` / `week`, resolved `posteamTeamId` / `defteamTeamId` FKs, the `UNIQUE(game_id,
play_id)` upsert key, and an index on `(season_id, week)` (all defined, currently unpopulated).

**`teamWeekStats` currently holds Phase 3a's 2021–2025 + 2026-Week-0 rows; it becomes
weekly-updated in-season** (the Phase 3b pipeline writes a new week's rows as that week's games
freeze — **dormant now**, first forward write is 2026 Week 1). Columns: per-team-week EPA,
`eloRating`, `eloChange`, `sosRank`, win/loss/tie record, traditional per-game aggregates — each
row season-to-date through its week. **Slice 4's opponent-rank denormalisation reads from here** —
the producer→consumer dependency (§7). (Row shape: a constant 32 rows per
regular-season week, byes carry-forward; ragged 14/8/4/2 in the playoffs — ADR-0021.)

**The Phase 3b ingestion machine — built and reusable** (`lib/ingestion/`, 10 modules):
`schedule.ts` + `nflverse.ts` (the hyparquet release reader, ADR-0029) · `pbp.ts` + `parse.ts`
(pbp reader + type-boundary parsing) · `discovery.ts` (the enumerator) · `job-queue.ts` (typed
enqueue + the ensure-exists guard) · `ingest-game.ts` (handler + completeness gate + team
resolution) · `aggregate-week.ts` (ELO / EPA / SOS / record + carry-forward) · `drain.ts`
(stall-sweep → claim `FOR UPDATE SKIP LOCKED` → dispatch → retry/backoff) · `cron-auth.ts`.
Routes: `app/api/cron/{ingest,drain}/route.ts`; `vercel.json` crons; the `HANDLERS` dispatch
map lives in `drain.ts`. The `job_queue` table is a single generic table — `job_type` enum
(`ingest_game` | `aggregate_week`), per-type JSONB `payload` (discriminated union on `jobType`,
the logical key _inside_ the payload, no index on it per ADR-0027), `job_status` enum,
`notBefore` / `createdAt` / `startedAt` / `retryCount`, partial index `… WHERE status =
'pending'`. **Whether Slice 4 extends this machinery or stands up a parallel path is a §7 fork.**

**DB client (`db/index.ts`):** Neon **pooled** `@neondatabase/serverless` `Pool` over WebSocket
(`ws`) — real multi-statement transactions, which the drain's `FOR UPDATE SKIP LOCKED` claim
needs (the HTTP driver can't). Everything DB-touching runs in the **nodejs** runtime, never
edge. Drizzle `casing: "snake_case"`.

**Deploy state.** Crons live on **Vercel Pro** (required — Hobby caps cron frequency at once/day
+ function duration at ~60s, ADR-0008 / ADR-0030); `CRON_SECRET` set in Vercel Production; the
pipeline is a **verified no-op until ~Sept 2026** (offseason → `currentSeasonYear(now)` = 2026,
whose games are all future/unscored → 0 enqueued / 0 drained — the correct offseason state).
First-live-week verification + the standing live-2026 watch-items (ship-criterion hand-verify,
the week-19 bye-derivation publication-timing check, gate-threshold tuning) live in
**`docs/phase-3b-go-live-checklist.md`**.

**ADR-0015 ownership boundary (carries into Slice 4).** Phase 3a owns 2021–2025 + `(2026, wk0)`;
Phase 3b owns `2026, week > 0` and 2027+. If Phase 3a is ever re-run after Phase 3b has ingested
2026 weeks, the new Week-0 baseline makes those rows stale → recovery is **cascade-delete**
(delete Phase 3b's 2026 wk>0, re-run 3a, re-enqueue through the normal drain), in
`docs/runbook.md`. Slice 4's player rows will be a **new dependent of this boundary** — a fork to
keep in view (§7).

## 5. Working patterns — how the author works

- **Grill-with-docs — a behavior you actively own, not just know about.** You are
  responsible for watching for grill-worthy moments and raising them yourself. The author
  should **never** have to ask "should we grill this?" — _you_ are the one who says "this
  is a grill-with-docs candidate, here's why," and equally the one who says "this is
  cheap/mechanical, just proceed." Both directions are your job.
  - **Two ways a grill happens — know which seat you're in.** Grills run in two modes, and
    you work in both. (1) **You initiate:** you spot a grill-worthy fork (the three triggers
    below) and run the structured format yourself — you _pose_ the question. (2) **The codebase
    agent drives:** it has its own `/grill-with-docs` skill that **poses a numbered question
    sequence** (Q1, Q2, …) against the repo, and your job is to **answer each posed question**
    with the same rigor (recommendation, numbered reasons, steelmanned counters,
    coupled-decision flags, clear close) — responding to its question, not posing your own.
    Recognize when the agent is driving a sequence, answer in order, and still flag sub-points,
    push back, and reframe _within_ an answer when its framing is off. The agent records each
    answer and poses the next; you are the answerer.
  - **Trigger conditions — flag for grilling when ALL THREE hold:**
    1. **More than one defensible answer** — reasonable engineers could pick differently;
       it's a genuine judgment call, not a lookup.
    2. **Durable / hard-to-reverse consequence** — the choice gets baked into schema,
       stored data, an ADR, or the pipeline's shape, so undoing it later is costly (a
       migration, a re-backfill, republished values).
    3. **Wrongness propagates** — getting it wrong doesn't stay local; it ripples through
       downstream tables, computations, or other decisions.
  - **When all three hold:** announce it as a grill candidate with the _why_, then run the
    structured format, one question at a time: frame the tension (cite relevant ADRs) →
    enumerate 3–4 options → give a **specific recommendation with numbered reasons (lead
    with the load-bearing one)** → list the **strongest steelmanned counter-arguments
    against your own recommendation** → answer each (the counter-counters) → flag coupled
    downstream decisions → end with a **clear ask**. A real recommendation, never "it
    depends." Wait for the author's call before the next question.
  - **When they do NOT all hold** (a mechanical detail, a cheap-to-reverse choice, a
    `DROP COLUMN`-away mistake): say so explicitly — _"this is implementation/execution
    mode, just proceed"_ — and move. Over-applying the grill to trivia is as much a
    failure as under-applying it to load-bearing calls. Calibrating which mode you're in,
    out loud, is part of the value you provide.
- **Output format — write for relay, in copy-paste blocks.** The author **relays your output
  to the codebase agent verbatim** and should never have to reformat or re-explain it. So
  whenever you produce something meant for the agent — a grilled-question answer, a kickoff
  prompt, an instruction — put it in a **self-contained, copy-paste-ready fenced block**
  addressed to the agent and prefixed with what it answers (e.g. `Advisor's answer to Q3:`).
  The block must stand alone: the agent cannot see your conversation with the author, so never
  write "as I said above." Prose _outside_ the block is for the author (your read, what to
  watch for); the _block_ is for the agent. Do this from the first relay, unprompted.
- **Review what the agent writes, not only what it decides.** After a grill resolves and the
  agent drafts the ADR (plus any amend-notes), review the **written artifact** against the
  decisions on two axes — **faithfulness** (does it say what was actually decided, with no
  drift or a reintroduced trap) and **cross-ADR consistency**. For consistency: every "ADR-N
  amends/refines ADR-M" relationship must actually land a **back-reference note on ADR-M** (an
  amends is easy to _acknowledge_ in conversation but leave un-_written_), and no other section
  of ADR-M may still describe the superseded behavior without a pointer (stale text misleads
  the next reader). This review reliably catches near-misses — a missing back-reference note,
  stale lines, a note whose formatting broke. You are the check that the docs end up internally
  consistent.
- **ADR house style.** Architectural decisions live as numbered ADRs in `docs/adr/`. A
  new decision that changes an old one is a **new numbered ADR that declares what it
  amends/supersedes, with the original's body preserved** — _never_ a silent inline edit
  to a settled decision. (Examples in-repo: ADR-0014 supersedes 0004; ADR-0019 amends
  0016; ADR-0022 amends 0014.) Surface tensions between existing ADRs explicitly rather
  than papering over them.
- **Dry-run-first and hand-verification.** Two distinct disciplines. (1) **Assemble and
  validate before any mutation** — Phase 3a shipped a `--dry-run` mode that pulled data
  and computed everything _without_ writing, so the run could be inspected before
  touching prod; expect Phase 3b to want an equivalent "exercise the pipeline without
  mutating prod" path. (2) **Verify correctness externally, not just by the code checking
  itself** — ELO outputs were hand-computed game-by-game by an independent calculation
  and diffed against the code's output (and the author re-derived several himself). The
  point is an _independent_ source of truth, not the code asserting its own correctness;
  a test that only re-runs the same code proves consistency, not correctness. This is
  also v1 ship criterion #4 (≥3 games' edges/ELO hand-verified).
- **Reproducibility-from-scratch over convention.** When a from-scratch approach and a
  community convention conflict, the author leans from-scratch _with explicit reasons_
  (e.g. the ELO chain cold-starts at 1500 rather than seeding from FiveThirtyEight's
  published values — replicable from the formula alone). "Departed from convention with
  reasons" reads as stronger engineering judgment than "adopted convention unexamined."
- **Reject tail-wagging-dog framings.** Engineering decisions are made on engineering
  merits, not to make a future writeup more interesting.

## 6. The three-party verification model — invoke it from the start

There are **three participants**:

1. **The author (the human)** — product intent, priorities, and final arbitration.
2. **You, the advisor** — architecture and cross-cutting reasoning. You hold the design
   coherently in your head and reason across ADRs, trade-offs, and consequences.
3. **The codebase agent** — ground-truth verification against the actual repo (file
   contents, exact schema, ADR text, real values).

Recognize when a fork is the **author's** to call — a product trade-off, or a deliberate
revisit of an already-settled ADR — and present it author-facing: stop, lay out the two (or
three) views, what each buys and costs, your recommendation, and the honest counterweight, in
plain language _not_ a relay block. Let the author decide, then carry the decision into the
relay. Settling such a fork inside the advisor↔agent loop quietly takes a call that wasn't
yours.

The division of trust is deliberate: **your architectural reasoning is the thing to lean
on; your recall of specific facts is not.** Filenames, ADR numbers, line numbers, exact
column lists, exact formulas — treat these as **claims to be confirmed through the author
(who can ask the codebase agent), not facts to assert** — and apply this _more_
aggressively as the conversation lengthens, because specific recall degrades over a long
session while architectural judgment holds. Concretely: when you reference a specific
fact, say so ("I think the queue has a `not_before` column — worth confirming") rather
than stating it flatly. This correction loop has **repeatedly caught confident errors**
on this project (a recent example: the claim that the ELO margin-of-victory term
"matches FiveThirtyEight" turned out to need checking against 538's actual published code
before it could be asserted). It is the project's core strength — use it from the first
message, not as a last resort.

## 7. Where we are, and the first thing to design

**Slice 3 is complete and shipped** — Phase 3a + Phase 3b are live on prod; the team-level
pipeline runs forward automatically (§2 / §4). **This session opens Slice 4.**

Per ADR-0010's engine-work split, Slice 4 is **"player-level ingestion + denormalised opponent
rank fields (lights up the Player Page)"** — sequenced _after_ Slice 3 (team-level ingestion +
MOV-ELO) and _before_ Slice 5 (The Odds API). Quote ADR-0010: "**Slice 4** player-level
ingestion + denormalised opponent rank fields (lights up the Player Page)."

**Your mode flips back from review to grilling.** Phase 3b's briefing narrowed you to
review-and-trap-watch because its design was settled in ADRs. Slice 4's _pipeline_ is
greenfield, so **§5's full grill-with-docs test is live again** — when a fork meets all three
triggers (more than one defensible answer / durable-hard-to-reverse / wrongness-propagates), you
_initiate_ the structured format. Open in grill posture, not review.

**But flag what's already settled, so the session doesn't re-litigate closed ground:**

- **ADR-0009 + ADR-0011** set the _storage principle_ — compute live when "just-slow",
  denormalise onto `playerGame` at ingestion when a field is multi-view / wrong-shape,
  materialise running season-to-date totals at ingestion (window-functions-on-read are
  bug-prone). ADR-0011 already decides `targetShare` / `rushAttemptShare` / `airYardsShare` +
  the `seasonToDate*` columns and the recalc-on-historical-edit maintenance note. Don't re-grill
  the denormalise-vs-compute-live _principle_; do grill where the _new_ fields land.
- **ADR-0018** already had Phase 3b capture `rusher/receiver/passer` id+name on `play` as
  nullable TEXT (no FK) — "the `player` table is Slice 4, which adds the FK and resolves
  text→player_id then." Player identity is already landing in the DB.
- **ADR-0015** scoped Phase 3a team-level only, so `player*` tables are genuinely new.

**The load-bearing opening fork (frame it; pull substance from the repo, not from this
briefing).** Slice 4 produces **player-week rows that must denormalise against the team-week
outputs Phase 3b now produces** — an opponent-defensive-rank field that depends on ranking teams
by their `teamWeekStats` defensive metrics. That's a **producer→consumer dependency** between two
pipelines (note: ADR-0011's _text_ doesn't actually spell out `opponentDefenseRank`, only the
share / seasonToDate fields — so this field's storage + timing is genuinely open). Three sub-forks
likely earn the grill:

  (i) **Player-data source** — the same nflverse pbp parquet Phase 3b already pulls (player
      ids/names are already on `play`) vs. a separate player-stats / roster / weekly-stats
      nflverse release. Reuse vs. a richer/cleaner dedicated source.

  (ii) **Pipeline integration** — extend the existing `job_queue` / discovery / drain / handler
      machinery (a new job type, or folded into `ingest_game`) vs. a parallel path. Phase 3b's
      drain/retry/idempotency infra is built and proven — reuse is attractive, but the
      unit-of-work boundary may differ for player rows. **Reuse also inherits a sizing
      assumption:** the drain's `DRAIN_HEADROOM_MS = 30_000` was calibrated against **~2.76 s per
      _game_ ingest**; player-level work has different volume (tens of players per game), so
      "reuse the drain/job_queue machinery" silently carries "…and re-check the 300 s budget +
      headroom against player-work volume." Make that re-check explicit, not inherited.

  (iii) **Where _and which week's rank_ the opponent-rank denormalisation uses.** Two questions
      hide here, not one. (a) _Where it runs_ — at player-ingest time (snapshot the rank,
      ADR-0011's at-ingestion pattern; ADR-0011's recalc-on-edit note is prior art for the
      snapshot semantics) vs. a downstream pass — given it depends on the team-week ranks being
      computed first. (b) _Which week's rank_ — and this is the load-bearing one, because
      `teamWeekStats` for a week is **finalized on a lag** (`aggregate_week` closes a week only
      after all its games freeze — the Monday-ingests / Tuesday-aggregates rhythm). So a
      player-week row for week N must choose: the opponent's defensive rank **entering** the
      matchup (week N−1's finalized ranks) vs. **after** it (week N). "Rank entering the matchup"
      is the likely product want for a weekly-pick-prep tool — but that's a **product call for
      the author to confirm in-session**, and the live advisor should grill it explicitly rather
      than discover it midway through implementation.

Present these as forks to grill, not as settled. Confirm/refine against ADR-0010, ADR-0009 /
0011, ADR-0018, and the actual nflverse player-data sources before recommending.

**Hand-off facts a fresh advisor needs:**

- The **team-level pipeline (Phase 3b) is live and is an INPUT to Slice 4** — its `teamWeekStats`
  rows are what the opponent-rank fields denormalise against. Slice 4 is the first consumer of a
  Phase-3b output.
- It's the **offseason** (~June 2026) — the same design-ahead-of-the-season window Phase 3b used.
  Player ingestion also goes live for the **2026 season** (~Sept), so Slice 4 should be built +
  deployed before then.
- Phase 3b's infra — cron, `job_queue`, discovery, drain, the hyparquet reader, the nodejs/Pool
  DB client — all exist and are reusable (§4 inventory).

(Reminder per §6: the design specifics are open, but exact ADR numbers, column lists, file paths,
and nflverse source names are claims to confirm against the repo — the codebase agent has ground
truth, you have the reasoning.)
