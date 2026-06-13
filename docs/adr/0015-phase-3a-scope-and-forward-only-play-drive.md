# Phase 3a scope: team-level only, play/drive forward-only via Phase 3b

ADR-0008 framed Phase 3a (the local Python backfill) as covering *"EPA-derived `teamWeekStats`, ELO trajectories, and player-game records across the prior N = 5 seasons."* That framing was written before Slice 3's vertical-slice scope was narrowed. With Slice 3 narrowed to team-level ingestion only (the player-level work moves to a later slice — see the ADR-0010 update that captures the engine-work split), Phase 3a's scope narrows in parallel.

**Phase 3a writes to three tables only**: `season` (rows for 2021-2026), `game` (rows for `seasonId ∈ 2021-2025`), and `teamWeekStats` (rows for `seasonId ∈ 2021-2025` ∪ `(seasonId = 2026, week = 0)`). `drive`, `play`, and `playerGame` are out of scope. EPA aggregation runs in pandas memory against parquet — one season's plays fit easily in laptop RAM — without persisting play rows to Postgres.

The decisive reasons for narrowing: Phase 3a's load-bearing output is the 2026 Week 0 ELO baseline that Phase 3b consumes, and every additional table is intermediate state that doesn't change the baseline; player-level backfill has materially different mechanics (denormalised `opponentDefenseRank*` requires `teamWeekStats` to be complete first, season-to-date totals require ordered per-player processing, `playerTeamMembership` reconstruction across mid-season trades for retired players); and ADR-0004's "range extension" framing already anticipated multiple backfill runs over time, so separating team-level from player-level matches a natural seam in the work.

## Forward-only `play` and `drive`

A consequence of the narrowing: the `play` and `drive` tables are **forward-only via Phase 3b**, empty for seasons 2021-2025 and populated from 2026 Week 1 onwards. This is a deliberate schema discontinuity, surfaced here as an ADR rather than buried in `docs/schema-design.md` so future-reader confusion has a durable record to point to. Queries that join `teamWeekStats` to `play` via `gameId` will silently return empty for historical weeks; future research investigations that need historical play-level data should run a separate later one-shot backfill at the time the need surfaces, on the principle that backfill-for-investigations is off the v1 critical path (ADR-0010).

The first published research investigation (the MOV-ELO methodology piece bundled into Slice 3 — see the ADR-0010 update for engine-work-and-publish coupling) draws its worked examples from `teamWeekStats` data: Phase 3a's historical output and Phase 3b's forward output as it accumulates. It does not depend on historical `play` or `drive` rows. This is consistent with the forward-only stance — the methodology piece's analytical needs are met by aggregate-level data, and ad-hoc parquet reads at publish time handle any future investigation requiring historical play-level context.

## Phase 3a / Phase 3b ownership boundary

Re-run safety hinges on a precise ownership boundary. **Phase 3a owns** the rows enumerated above and nothing else. **Phase 3b owns** every row for `seasonId = 2026` with `week > 0`, plus all rows from 2027 forward. Phase 3a's idempotent re-runs delete-and-reload only Phase 3a-owned rows, never touching Phase 3b's output — preserving the invariant that Phase 3a can be re-run safely at any point without corrupting Phase 3b's ingested data.

The corollary: re-running Phase 3a *after* Phase 3b has ingested 2026 in-season weeks produces a new 2026 Week 0 baseline that is no longer the input Phase 3b's existing Week 1+ rows were computed from. The downstream 2026 rows are now stale. The recovery procedure (documented in `docs/runbook.md`) is **cascade-delete**: delete Phase 3b's 2026 weeks > 0, re-run Phase 3a, then re-enqueue post-game jobs for the deleted weeks via the standard Phase 3b drain path. If cascade-delete becomes frequent in practice (more than once or twice in v1), invest in a dedicated rewind script; premature otherwise.

## Idempotency mechanics

Phase 3a uses a hybrid idempotency strategy: `INSERT ... ON CONFLICT DO NOTHING` for `season` (rows are immutable reference data with `year` as natural key), and **transaction-wrapped truncate-and-reload** for `game` and `teamWeekStats`. The DELETE WHERE clauses encode Phase 3a's ownership boundary precisely (`teamWeekStats: season_id IN (2021..2025) OR (season_id = 2026 AND week = 0)`; `game: season_id IN (2021..2025)`) so re-runs are scoped, never accidentally clobbering Phase 3b's data. Bulk inserts use multi-row VALUES in ~500-row chunks; the entire run is one transaction on one pooled connection. Either all rows commit or none — there is no partial-state recovery problem to solve. A `--dry-run` flag pulls parquet and computes aggregations without executing mutations, supporting development iteration and pre-commit methodology validation against the MOV/cold-start chain.

## Pre-Phase-3a cleanup

Slice 1 deployed hand-seeded data for the 2024 season (one `season` row plus dependent `game` and `teamWeekStats` rows) to populate the Slate Dashboard before real ingestion landed. Phase 3a's 2024 backfill would collide with this hand-seeded data. The cleanest path is a one-shot pre-Phase-3a DELETE:

```sql
-- Run once, before Phase 3a's first execution
DELETE FROM team_week_stats WHERE season_id IN (SELECT id FROM season WHERE year = 2024);
DELETE FROM game WHERE season_id IN (SELECT id FROM season WHERE year = 2024);
DELETE FROM season WHERE year = 2024;
```

**[Backup *sequencing* amended by ADR-0024: backup-FIRST, before the cleanup, capturing the validated Slice 1 state. The post-cleanup state is empty (Slice 1 seeded only 2024), so the "ready for Phase 3a" target below is an empty DB; build.py's idempotency also removes the clean-start rationale. The reasoning below is preserved for history.]**

The named Neon backup branch (see "Prod-safety three-layer defense" below) is taken **after** this cleanup, so the backup captures the "ready for Phase 3a" state — restoration returns to a clean pre-backfill state, not to the Slice 1 final state. (If the operator ever needs to restore beyond Phase 3a back to Slice 1 final, that's a different concern requiring a different branch from Slice 1's deployment time.)

## Prod-safety three-layer defense

Phase 3a writes directly to prod over a Neon connection string (per ADR-0008's "writing directly to Neon" framing), protected by three independent safety layers: `--dry-run` catches algorithmic errors before any DB write, the transaction wrap catches mid-run crashes, and a **named Neon backup branch** (created after the Slice 1 hand-seeded cleanup DELETE and before Phase 3a runs) catches committed-but-wrong values discovered post-hoc. The script's success output prints five verification queries — 2026 Week 0 distribution check, one team's 5-season trajectory sanity check, row counts, orphan check, and the hand-verification reminder for ADR-0012 #4 — plus the literal `neonctl` cleanup command for the backup branch. The "every production write goes through staging" reflex is correctly characterized as a mismatch for one-shot scripts with bounded scope and explicit recovery — it exists for systems with concurrent writers, race conditions, and partial-state ambiguity, none of which Phase 3a has.

A separately considered option — pausing the Vercel deployment during Phase 3a to prevent intermediate state from being visible to users — is **explicitly rejected**: the transaction wrap already makes intermediate state invisible. The consideration is recorded here so it isn't re-litigated later.
