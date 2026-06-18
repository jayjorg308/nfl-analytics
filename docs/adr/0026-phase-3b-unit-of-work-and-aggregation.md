# Phase 3b unit of work: per-game ingestion + per-week aggregation

ADR-0016 settled Phase 3b's cron triggers and retry mechanics — "discover expected work
for the day," "drain as many jobs as fit" in Vercel's 300s window, with
retry/backoff/completeness all operating **per job** — but it never pinned the
*granularity of a job*. That granularity is load-bearing: it determines the chunking, the
`jobQueue` table shape, how the completeness gate (ADR-0019) attaches, and how write-once
and the cascade boundary (ADR-0015, ADR-0019) behave. This ADR closes that open question.

It **builds on and references** ADR-0008 (Vercel runtime, the `jobQueue` chunking pattern,
the 300s ceiling), ADR-0016 (cron cadence, drain query, retry/backoff), ADR-0019
(write-once + the completeness gate), ADR-0018 (`play` column inclusion), ADR-0015 (Phase
3a/3b ownership boundary and cascade-delete), and ADR-0021 (playoff `teamWeekStats`
representation). It **supersedes none** of them — it pins a parameter ADR-0016 explicitly
left open and specifies a production mechanism ADR-0021 explicitly left unspecified, and
reverses nothing they decided, so no back-reference note is added to any of them (the same
convention by which ADR-0019 amended ADR-0016 without editing it).

## Decision: a two-tier unit of work

Phase 3b's work for a given week splits along the one genuine dependency boundary — *all
of a week's games must be ingested before that week's cross-team aggregate can be
computed* — into two job types and nothing finer.

**1. `ingest_game` — one job per game.** Reads its game's plays from the week's
play-by-play parquet, writes the game's `game` / `drive` / `play` rows, and runs the
per-game completeness gate (score reconciliation against the `game` row's final score,
plus the play-count floor — ADR-0019). On pass the job is marked `completed`; on a failed
gate it re-enqueues through ADR-0016's existing `not_before` / exponential-backoff path.
Keyed by `nflverseGameId` — the `game.nflverseGameId` unique column that is already the
ingestion upsert key.

**2. `aggregate_week` — one job per (season, week).** Gated on its week's games being
complete (see the precondition guard below). Reads the prior week's `eloRating` to advance
the ELO chain, **recomputes** the cumulative EPA (the `*EpaPerPlay` columns) and the
traditional per-game columns from the `play` and `game` rows by season-to-date aggregation
(see the 300s budget section), computes the cross-team `sosRank` ranks, and increments the
win/loss/tie record; then writes that week's rows (including carry-forward rows — see the
production rule below).

**`jobType` enum:** `ingest_game | aggregate_week`, each carrying a per-type JSONB
payload — `ingest_game`: the `nflverseGameId` plus the week / parquet reference;
`aggregate_week`: the season, the week, and the **snapshotted expected-game count** (see
the denominator section). At the TypeScript boundary the payload is typed as a
**discriminated union on `jobType`**, parsed and narrowed once at drain time so each
handler receives a typed payload rather than raw JSONB.

## Precondition guard, not a dependency engine

`aggregate_week` is drained on the normal cadence like any other job. When drained it
checks `COUNT(complete games for week N) == expected`. If the count is unmet, it
re-enqueues itself through the **existing** `not_before` / backoff path rather than
running. This is the same "one retry mechanism, multiple triggers" move ADR-0019 made for
the completeness gate (non-arrival and partial-arrival both route into ADR-0016's retry):
the unmet precondition is simply a further trigger reusing the same path. There is **no
`depends_on` column and no new dependency-resolution machinery** — the queue stays a flat
drain.

## The "expected games for week N" denominator

The precondition count is sourced from the **nflverse schedule** and **snapshotted at
discovery time** into the `aggregate_week` payload — read once when the job is enqueued,
not live on every drain — so the denominator is stable for the week being ingested.

- **Regular season:** known statically. Flex scheduling moves a game's slot or day, which
  is a *which-cron-window* concern under ADR-0016's active-window design, but never changes
  the count of games in a week.
- **Playoffs:** the gate only ever needs the **current** round's count, and the current
  round's matchups are always set by the time that round is ingested (see week-reactive
  discovery). The counts are fixed by format: WC = 6, DIV = 4, CON = 2, SB = 1; playoff
  weeks are numbered 19–22 (WC=19 … SB=22, per ADR-0021).
- **Rare slate changes** (a cancellation or postponement) fall through to ADR-0016's
  5-attempt → `failed` → human-attention path. No special-case machinery.

## Discovery: week-reactive enqueue

Each cron run pulls the season parquet once (ADR-0016: parquet is re-downloaded per
invocation; the Week-18 peak is well under 100 MB) and reads the schedule, then enqueues
the `ingest_game` jobs for the games present plus the single `aggregate_week` job for the
week, stamped with the snapshotted expected count. Discovery **never pre-enqueues the
whole season ahead of time**: playoff `nflverseGameId`s do not exist until each round's
matchups are set, so enqueue must *react* to the schedule as the bracket fills in
round-by-round. (This is also why the denominator is snapshotted per week at discovery
rather than computed once for the season.)

## Carry-forward production rule (teams that do not play a given week)

A team that does not play in week N still needs a `teamWeekStats` row in the cases
ADR-0021 enumerates (regular-season byes; the wild-card #1-seed byes). The **semantics**
of such a row are **fully settled by ADR-0021** and are not re-decided here: ELO unchanged
(`eloChange = 0`); the seven EPA columns, the six traditional per-game aggregates, and
`sosRank` frozen at their prior values; and the record columns carried forward unchanged —
which is consistent with ADR-0021's "advancing as a count" treatment of
`recordWins` / `recordLosses` / `recordTies`, because a team that did not play has no
W/L/T to add (record advances only on a played game, so carry-forward leaves it where it
was).

What ADR-0021 leaves open — and what this ADR fixes — is the **incremental production
mechanism**. Phase 3a produced these rows for free by building a whole-season team×week
grid in one pass (`aggregate.py` reindexes the grid so byes become explicit zero-rows);
that whole-season trick does not transfer to the incremental weekly path. The incremental
rule branches on `gameType`:

- **Regular-season week → emit all 32 rows.** Played teams are computed from their games;
  the 2–6 teams on bye are carried forward. Carry-forward here is **unconditional** —
  every team is alive, so a team simply not appearing in the week's games is a bye.
- **Playoff week → emit one row per team in that week's *completed* games, plus — in
  wild-card week only — a carry-forward row for the two #1 seeds.** Eliminated teams do
  not appear at all. Under the current 14-team playoff format the wild-card #1-seed bye is
  the **only** alive-but-not-playing case; the divisional, conference, and Super Bowl
  rounds are all-play. This branch is therefore **format-dependent**: a change to the
  playoff format (e.g. a different number of byes) reopens it.
- The wild-card #1-seed byes are derived as **the playoff field minus the teams playing
  wild-card games** (read off the WC slate), not by re-deriving conference seeding.

The crucial difference from the regular season is that playoff carry-forward is
**conditional on a team still being alive**, whereas regular-season carry-forward is
unconditional. The incremental path cannot use "did not play → carry forward" in the
playoffs; it must distinguish alive-but-bye from eliminated.

**Post-condition assertion.** After producing a week's rows, assert the row count equals
the expected **32 / 14 / 8 / 4 / 2** for weeks {0–18 / 19 / 20 / 21 / 22} (ADR-0021's
verified table). A wrong alive/eliminated predicate fails this assertion loudly and
immediately — a cheap guard on the one genuinely error-prone part of the rule.

## The 300s budget

`ingest_game` is bounded by a single game's plays. `aggregate_week` does **not** carry a
running cumulative forward — `teamWeekStats` stores per-play *means* (the `*EpaPerPlay`
columns) and per-game *rates* (the traditional aggregates), not the running sums and counts
a "previous cumulative + delta" step would need. Instead it **recomputes each cumulative
column from source** every week, which is safe precisely because the job is already gated
on that week's plays being present:

- The seven `*EpaPerPlay` columns and the yardage among the traditional per-game aggregates
  (`passYardsPerGame` / `rushYardsPerGame` and their `…Allowed…` counterparts) are
  recomputed by a **season-to-date aggregation over `play`**, attributing each play to its
  team via `posteam` (offense) / `defteam` (defense) and filtering `season = S AND
  week <= N`, over ADR-0020's universes (scrimmage `pass | rush` for EPA, all offensive
  plays for the box-score yardage). `pointsScoredPerGame` / `pointsAllowedPerGame` come
  from the `game` rows' final scores over the same season-to-date span. Each is divided by
  games played to date.
- `eloRating` / `eloChange` are read from the prior week's row and advanced by this week's
  game outcomes — the ELO chain is genuinely incremental (a rating, not a cumulative mean).
- `recordWins` / `recordLosses` / `recordTies` is an incrementable count.

The 300s bound holds by a **scan-size** argument, not an incremental-carry one: the
cumulative is *season-to-date* and `teamWeekStats` is per-season cumulative (it resets each
season), so the aggregation is bounded by **one season** of plays — low thousands of plays
per team, the full league comfortably inside the same `<100 MB` season parquet that
`ingest_game` already works against — never the ever-growing multi-season `play` table. An
indexed season-to-date scan over a single season is cheap.

**Caveat — chunking is sized against an estimate until measured.** Actual plays per game
is unmeasured: the `play` table is greenfield (forward-only per ADR-0015; columns governed
by ADR-0018), so no in-repo play volume exists. The working ~150–180 plays/game figure is
an estimate. Validate the chunking — how many `ingest_game` jobs fit in one drain window —
against real volume on the first live ingestion week, not the estimate.

## Alternatives considered

- **A — Week-grained** (one job ingests *and* aggregates the whole week). Rejected:
  forces all-or-nothing completeness on a unit whose completeness is the logical AND of its
  games, producing partial-commit / partial-retry mess and re-pulling already-settled games
  on retry (brushing against write-once). Decisively, it **cannot meet ADR-0006's freshness
  contract**: a week is not complete until Monday Night Football (Tuesday), yet Sunday's
  games are promised by Monday morning — a week-grained unit could not deliver Sunday by
  Monday.
- **B — Game-grained but flat** (fold `teamWeekStats` into the per-game job). Rejected: the
  cross-team ranks (`sosRank`) are a whole-week, whole-league reduction and cannot be
  produced inside a single-game job.
- **C — Generic stage explosion** (pull / write-plays / aggregate as arbitrary chained
  stages). Rejected: more job types than the real dependency structure needs. The chosen
  design is the disciplined **two-type** subset cut along the one genuine boundary — all of
  a week's games in before that week's aggregate — and nothing finer.

## Consequences and coupled decisions

- **The `jobQueue` table shape follows from this decision.** The implied shape is a single
  generic table: the `jobType` enum, a per-type JSONB payload, a `status` enum
  (`pending` / `in_progress` / `completed` / `failed`), `not_before`, `created_at`,
  `retryCount`, and a partial index `WHERE status = 'pending'`. This is consistent with the
  shape sketched in the Slice-3 grilling and with the drain/retry columns ADR-0016 already
  references (`status`, `not_before`, `created_at`, `retryCount`, `FOR UPDATE SKIP LOCKED`,
  the 15-minute stall sweep). The table does not yet exist in `db/schema.ts`; its physical
  migration / DDL is a follow-on to this ADR, not part of it.
- **Cascade / re-run (ADR-0015) stays clean.** Work units are `nflverseGameId`-keyed, so a
  cascade-delete re-run is a straightforward per-game replay through the same drain path.
- **Dashboard scheduled-row preload is explicitly out of scope.** Whether Phase 3b mirrors
  the schedule into `game` rows so a future-slate dashboard view can render upcoming games
  is an independent, non-gating product choice. The aggregation gate sources its
  denominator from the schedule regardless, so it is self-sufficient either way.
- **Cumulative columns are recomputed from source each week, not carried.** Because
  `teamWeekStats` stores per-play means and per-game rates rather than the running
  sums/counts a carried delta would need, `aggregate_week` recomputes each cumulative
  column by season-to-date aggregation over `play` / `game` (the ELO rating is read from
  the prior row and advanced; record is incremented). This (a) needs **no schema change**
  and leaves Phase 3a's historical `teamWeekStats` rows untouched, and (b) is **drift-free
  and cascade-robust** — recompute-from-source cannot desync from the underlying `play`
  rows after a partial write or an ADR-0015 cascade re-run, the way a carried cumulative
  could.
- **Requirement on the greenfield `play` table:** the season-to-date per-team aggregation
  needs an index supporting `WHERE season = S AND week <= N` grouped by the
  offense/defense team key — i.e. an index on `play (season, week)` alongside the
  team-attribution columns (`posteam` / `defteam`, per ADR-0018's descriptor set). The
  follow-on `play` / `jobQueue` migration must include it. ⚠️ Exact realization is
  deferred: `play` is greenfield, so whether `season` / `week` / team are stored directly
  on `play` (ADR-0018 lists them in the descriptor set) versus reached by a join to
  `game`, and whether the team is the nflverse abbreviation or a resolved `team_id` FK
  (`teamWeekStats.teamId` is a `team_id` FK; `posteam` / `defteam` arrive as abbreviations
  from nflverse) — and therefore the precise index columns — are fixed by that migration /
  `docs/parquet-mapping.md` per ADR-0018, not here.

## Pre-registered 2026-postseason live check

Mirroring ADR-0019's forward-validation discipline: during the first live playoffs,
confirm that the nflverse schedule exposes each round's **real matchups** promptly enough
after the prior round finalizes that discovery picks them up before that round's drain
window opens. If publication lags badly, the fallback denominator/slate source for playoff
weeks is bracket- or pbp-derived rather than the schedule. This is an operational timing
watch-item, not a design blocker — ADR-0016's retry already absorbs a publication lag (the
`aggregate_week` precondition simply stays unmet and re-enqueues until the round resolves).

## Open implementation items (flagged, not blockers)

1. **Exact record-column treatment on carry-forward rows** — confirmed against ADR-0021
   here (carried forward unchanged, consistent with "advancing as a count"); re-confirm at
   build that the handler increments record only on played games.
2. **plays/game measurement** on the first live ingestion week → finalize `ingest_game`
   chunking sizing.
3. **The playoff-schedule-publication live check** above.

## Cross-references

- ADR-0008 — Vercel ingestion runtime, the `jobQueue` chunking pattern, the 300s ceiling.
- ADR-0016 — cron cadence, the drain query, retry/backoff; preserves ADR-0006's Monday
  freshness contract.
- ADR-0019 — write-once forward ingestion and the completeness gate whose retry path this
  reuses.
- ADR-0018 — `play` column inclusion (the columns `ingest_game` writes).
- ADR-0015 — Phase 3a/3b ownership boundary and cascade-delete re-run.
- ADR-0021 — playoff `teamWeekStats` representation and carry-forward semantics (this ADR
  supplies the incremental production mechanism it left open).
- ADR-0023 — strength-of-schedule / `sosRank`, the cross-team reduction computed in
  `aggregate_week`.
