# Slice 4 build checklist — player-level ingestion + opponent-defense-rank

The authoritative task list for building Slice 4. Every item is an obligation the three Slice-4
design ADRs created; this document consolidates them so the build session runs one ordered list
and nothing scattered is left behind.

**Design ADRs (read first):**
- **ADR-0031** — player-data source + identity resolution (pbp facts + identity-of-record; roster
  enrichment; upsert-on-miss).
- **ADR-0032** — pipeline integration (fold per-game player facts into `ingest_game`, post-gate
  atomic).
- **ADR-0033** — opponent-defense-rank (`defenseRank*` on `teamWeekStats` via `aggregate_week`,
  read by the opponent-N−1 join).

**Build order rationale.** Schema before code (ingest/aggregate write to the new tables); the
folded ingest before its deferred doc-comment update (the comment describes the shipped behavior);
verification after the code runs live. Follow the section order top to bottom.

---

## 1. Schema / migration

- [ ] **`player` dimension table (ADR-0031).** Columns with the **writer column-ownership
      partition** — two name columns, one writer each:
  - `gsis_id` — text, **NOT NULL**, the natural/join key + upsert conflict target. **pbp-owned.**
  - `placeholder_name` — text, **NOT NULL**. **pbp-owned**, written once via `DO NOTHING`, never
    touched again.
  - `canonical_name` — text, **nullable**. **enrichment-owned** (the *only* writer).
  - `position` — text, **nullable**. **enrichment-owned.**
  - `team` — **nullable**. **enrichment-owned.**
  - Display name resolves as `canonical_name ?? placeholder_name` (provably non-null);
    `canonical_name IS NULL` is the honest "seen-but-not-yet-enriched" signal.
  - The `player` dimension is shared and **does NOT cascade-delete** with `game` (like `team`).
- [ ] **`playerGame` fact table (ADR-0011 / 0032 / 0033).** Per-game per-player row. Columns:
  - Identity: `player_id`/`gsis_id` FK → `player`, `game_id` FK → `game`, and **`team_id` FK →
    `team` — REQUIRED (ADR-0033):** the player's game-team, sourced at fold time from
    `play.posteamTeamId` of the player's plays (a player is on exactly one team per game). This is
    what lets the opponent-N−1 read join identify the opponent (the game's *other* team). Do **not**
    omit it — the read path depends on it.
  - Derived metrics (ADR-0011, denormalised at ingestion): `targetShare`, `rushAttemptShare`,
    `airYardsShare`.
  - Materialised running totals (ADR-0011): `seasonToDatePassYards`, `seasonToDateRushYards`,
    `seasonToDateRecYards`.
  - Unique constraint on `(game_id, player_id)` — the upsert conflict target (idempotent re-ingest).
- [ ] **`teamWeekStats` — add `defenseRankPass` / `defenseRankRush` (ADR-0033).** **NULLABLE**
      integer (unlike `NOT NULL` `sosRank`): week-0 baseline rows have no rank, which is what makes
      the week-1 "entering" read structurally NULL.
- [ ] **`playerGame` cascade-delete (ADR-0032).** The repo uses **no FK `ON DELETE CASCADE`** —
      `play`/`drive` are removed by the runbook's **explicit ordered DELETE** sequence. Add
      `playerGame` (for `2026, week > 0`) to that sequence in `docs/runbook.md`, deleted **before
      `game`**. Correctness, not tidiness: `playsFrozenAt` now certifies `playerGame` rows exist, so
      a surviving `playerGame` row after a re-ingest orphans a vanished player.
- [ ] **`playerSeasonStats` is DEFERRED** (Q2 / Fold-2) — not a Slice-4 table. `playerGame.
      seasonToDate*` + a live games-played count serve the MVP's season-to-date reads (ADR-0009
      compute-live). Do not build it this slice.

## 2. Ingest / aggregate

- [ ] **Fold per-game player facts into `ingest_game` (ADR-0032).** Reuse the plays already held in
      memory (`readGamePlays` output — no second read). Structure:
  - **Play-writes transaction UNCHANGED** (still commits `game`/`drive`/`play` pre-gate,
    independent of the gate verdict).
  - **NEW post-gate transaction, atomic, on gate-pass only:**
    `{ player ensure-exists upserts + playerGame writes + SET playsFrozenAt }`.
    - Player upsert: `INSERT … ON CONFLICT (gsis_id) DO NOTHING` over the **distinct `(gsis_id,
      name)` set** across the three role columns (rusher/receiver/passer) — a Set of cardinality
      0–N, not a fixed-arity pair (ADR-0031). Ensure-exists shape (ADR-0027 B), **not** the
      `excludedSet`/`DO UPDATE` path — so it never clobbers enrichment-owned columns.
    - `playerGame` writes: compute the ADR-0011 shares + `seasonToDate*` (reads the player's
      prior-week `playerGame` rows — safe: forward write-once + ≤1 game/player/week) and the
      `team_id` (from `play.posteamTeamId`); upsert on `(game_id, player_id)`.
  - **Failure semantics:** player-agg throws → marker unset → discovery re-mints → retry (a
    frozen-but-player-less game would break tier-2, so agg success gates the freeze). The gate
    **check** stays plays-only (ADR-0019).
- [ ] **`defenseRank*` in `aggregate_week` (ADR-0033).** In `lib/ingestion/aggregate-week.ts`:
  - Add `defenseRankPass` / `defenseRankRush` to the `Rates` type.
  - Compute in `recomputeRates` mirroring the `sosRank` shape (dense positional `1..N`, tie-break
    abbreviation ascending, single-transaction upsert) **BUT with an ASCENDING comparator** —
    lowest `defensivePassEpaPerPlay` / `defensiveRushEpaPerPlay` = rank 1 = best defense.
    **REQUIRED code comment** at the computation stating the direction **and** the reason
    (def-EPA columns are stored offense-perspective, no sign flip — `aggregate-week.ts:350` — so a
    good defense has a low/negative value; this is the opposite of `sosRank`'s descending sort and
    the silent-failure spot). Not advisory.
  - Freeze in `frozenRatesFromWeek18` (playoff weeks read the frozen week-18 rank, ADR-0021).
  - Week-0 baseline rows keep `defenseRank*` NULL (no `aggregate_week` runs for week 0).

## 3. Read path (Player Page consumer)

- [ ] **Opponent-N−1 join (ADR-0033).** The Player Page surfaces a matchup's "entering" opponent
      rank by joining, **not** a stored per-player column:
      `playerGame → game` (opponent = the game's other team, via `playerGame.teamId`)
      `→ teamWeekStats(opponent, season, week−1)` → `defenseRankPass` / `defenseRankRush`.
      Equality join on the `(team, week)`-indexed 32-row-per-week table; correction-propagation is
      automatic (recompute re-ranks, join reads current-frozen). (May land with the Player Page
      view depending on slice sequencing, but the obligation belongs to Slice 4's data contract.)

## 4. Deferred doc-comment obligations (when the fold ships)

- [ ] **Update `db/schema.ts`'s `playsFrozenAt` comment (ADR-0032).** It currently describes the
      marker as plays-only (correct as-built, pre-fold). When the §2 fold lands, widen it to the
      **plays-complete AND per-game player facts materialised** meaning, so the deferral does not
      rot into stale plays-only text.

## 5. Verification (go-live, first live 2026 week)

Recorded on `docs/phase-3b-go-live-checklist.md` §6 (they cannot run in the offseason — `play` /
`playerGame` are empty until Week 1).

- [ ] **`defenseRank*` external hand-verify (ADR-0033, ship-criterion #4).** A defense independently
      known elite (or terrible) in a settled week must land at the right end of the rank. A
      same-code test proves consistency, not correctness — the inversion would pass one silently, so
      verify against an external known-good.
- [ ] **Null-rate sample (ADR-0031).** Confirm `gsis_id` is populated **when a role participant is
      present** (per-play nulls are high and expected — role structure), sampled against the
      backfill 2021–2025 pbp. **If NOT clean → policy (a) needs a null-id skip/quarantine clause,
      which REOPENS ADR-0031** — flag it, do not paper over.
- [ ] **`ingest_game` live wall-time (ADR-0032).** Confirm a live Week-1/2 `ingest_game` with player
      facts folded in stays comfortably sub-300s (the 2022-24 hyparquet proxy measured ~2s, ~100×
      under the ceiling). Vercel function logs show per-invocation duration.

## 6. Non-blocking follow-ons (record — do NOT gate the MVP)

- [ ] **Players-release enrichment spike (ADR-0031).** Add a `playersReleaseUrl()` builder, point
      the existing generic `readReleaseParquet` (`lib/ingestion/nflverse.ts`) at the players asset,
      confirm `hyparquet` parses its schema and `gsis_id` is the key. ADR-0013-style; non-MVP-
      blocking by construction (the MVP lights the Player Page on pbp-only identity).
- [ ] **Enrichment cadence fork (ADR-0031).** Full-refresh cron vs. queued `job_queue` units
      (~2–3k active players — a full refresh may beat per-unit jobs). Its own decision when
      enrichment is built.

---

## Traceability (every obligation → its ADR)

| Obligation | ADR |
| --- | --- |
| `player` dimension + writer column-ownership partition | 0031 |
| pbp ensure-exists upsert (`DO NOTHING`, distinct-set) | 0031 / 0027 |
| `playerGame` derived metrics + `seasonToDate*` | 0011 |
| `playerGame.teamId` (required, for the opponent join) | 0033 |
| Fold facts into `ingest_game` post-gate atomic | 0032 |
| `playsFrozenAt` widened meaning + comment update | 0032 / 0028 |
| `playerGame` in the runbook cascade-DELETE sequence | 0032 / 0015 |
| `defenseRank*` columns + ASCENDING compute + freeze | 0033 |
| Opponent-N−1 read join | 0033 |
| `defenseRank*` hand-verify / null-rate / wall-time | 0033 / 0031 / 0032 |
| Enrichment spike + cadence (non-blocking) | 0031 |
| `playerSeasonStats` deferred (do NOT build) | Q2 / Fold-2 |
