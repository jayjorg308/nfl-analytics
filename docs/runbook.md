# Operational runbook

This runbook documents manual-override and recovery procedures for the gated app's analytical data. It is the documented fallback path for tables where ADR-0017 classifies the source as low-error-rate (`game`, `teamWeekStats`, `play`, `drive`, `playerGame`, `playerSeasonStats`, Odds API tables) — corrections happen via direct SQL through the Neon console rather than through an admin UI. For tables classified as high-error-rate (injuries, weather overrides, manual prop entries), corrections happen through admin UI bundled with the slice that introduces them; those procedures are documented in the relevant slice's surface, not here.

The audience for this runbook is the project operator (you) running corrective SQL against the Neon prod branch. The friend-tier audience never sees these procedures — by ADR-0001, the database stores no user-generated content, so there is no user-facing correction workflow to document.

## General principles

Before any non-trivial write to prod, apply the universal pre-write discipline:

**1. Backup branch first.** Take a named Neon backup branch (`pre-<procedure>-<YYYY-MM-DD>`) via `neonctl branches create` or the Neon console. The backup captures the pre-write state for explicit recovery; PITR is the implicit backstop, but explicit named branches are auditable in the console and make the recovery target obvious. Delete the backup branch after 24-48 hours once the corrected state is validated.

**2. Transaction wrap multi-statement writes.** Any procedure touching more than one row, or touching rows across more than one table, runs inside `BEGIN ... COMMIT`. Either every statement commits or none do; there is no partial-state recovery problem to solve. Single-row UPDATEs touching one column may be issued without an explicit transaction.

**3. Document the reason.** Manual corrections to analytical data are rare. When they happen, the reason should be findable later — the commit message (if the correction is tied to a git change), a Linear/issue tracker note, or a comment in this runbook's procedure history if neither applies. "Why did we change this row?" is a question future-you will ask; record the answer in the moment.

**4. Run verification queries after.** Each procedure below ends with a verification SELECT that confirms the corrected state. Run it before deleting the backup branch. The verification is the gate, not the commit.

## Procedures

### Correcting a game outcome

**Scope:** Final score wrong (data-entry error from nflverse, manually overridden after a confirmed correction), or game-level metadata wrong (date, home/away assignment for neutral-site games, etc.).

**Downstream impact:** Game outcome feeds the ELO computation. Correcting an outcome after `teamWeekStats` has been computed requires recomputing ELO from the corrected game forward through every subsequent game both teams played in that season — and propagating the corrected ELO into the next season's Week 0 baseline via the inter-season regression rule (ADR-0014).

**Procedure (historical seasons 2021-2025, before Phase 3b has ingested forward from the game):** Phase 3a's `scripts/backfill/build.py` recomputes the entire ELO chain from the 2021 cold start in one pass, so a historical outcome correction does not need a surgical "recompute from game N forward" — it needs the source corrected and the chain re-run.

1. **Backup branch** (General principle #1): `neonctl branches create --name pre-game-correction-<YYYY-MM-DD>`.
2. **Correct the source.** nflverse is the system of record; if it published a corrected score, re-running `build.py` picks it up automatically (it re-pulls schedules). If the correction is a manual override nflverse will never carry, it cannot flow through `build.py`'s pull — apply it as a direct `UPDATE` to the `game` row, and record that any later `build.py` re-run will revert it (override and re-run must be coordinated, or the override re-applied after).
3. **Re-run the backfill:** `cd scripts/backfill && uv run build.py` (no `--cleanup-2024` on a re-run). The transaction-wrapped scoped truncate-and-reload replaces `game` + `team_week_stats` for 2021-2025 atomically (ADR-0015), recomputing ELO across every subsequent game both teams played and the 2026 Week-0 baseline via the inter-season regression (ADR-0014).
4. **Verify:** `node scripts/verify-phase3a.mjs` — confirm `21 PASS / 0 FAIL`, and diff the output against the known-good reference if one was captured.

If Phase 3b has already ingested 2026 in-season weeks, the corrected 2026 Week-0 baseline makes those rows stale — follow "Re-running Phase 3a after Phase 3b is active" below instead.

### Correcting `team_week_stats` values

**Scope:** EPA aggregates wrong (upstream play-level data was corrected and the rollup is stale), SOS values wrong, traditional stat aggregates wrong. Does *not* cover ELO corrections — those go through the game-outcome procedure above because ELO is iterative.

**Downstream impact:** `team_week_stats` is read by the Slate Dashboard's `weekSummary` view directly. Corrections take effect immediately on next page render. Per ADR-0011, the materialised values on `playerGame` (`opponentDefenseRankPass/Rush`) reference `team_week_stats` at time of ingestion — historical corrections to `team_week_stats` do not auto-propagate to `playerGame`, and a separate cascade is documented as an admin operation when `playerGame` data exists.

**Procedure:** `team_week_stats`' derived columns are computed by `scripts/backfill/build.py` — EPA and pass/rush yards from parquet, record and points from the schedule, SOS from the ELO chain. A wrong aggregate almost always means the computation or its input is wrong, not the stored row, so the correction is to fix the input and re-run, not to `UPDATE` the cell:

1. **Backup branch:** `neonctl branches create --name pre-tws-correction-<YYYY-MM-DD>`.
2. **Fix the input.** If a parquet revision corrected upstream data, re-running `build.py` picks it up. If it is a *methodology* change, edit the relevant module (`aggregate.py` for EPA, `sos.py` for SOS, `build.py` for record/traditional) **and** refresh the governing ADR — these values are methodology-locked (EPA: ADR-0020, SOS: ADR-0023), so the ADR and the code move together.
3. **Re-run:** `cd scripts/backfill && uv run build.py` (scoped truncate-and-reload, atomic).
4. **Verify:** `node scripts/verify-phase3a.mjs` (`21 PASS / 0 FAIL`). Corrections take effect on the Slate Dashboard immediately via the `week_summary` view; per ADR-0011, materialised `opponentDefenseRank*` on `playerGame` does not auto-propagate (a separate cascade when that data exists).

A genuine one-off single-cell fix (the rare case where a full re-run is not warranted) is a single-row `UPDATE` per General principle #2 — but note it will be overwritten by the next `build.py` re-run, which is the authoritative source for these columns.

### Re-running Phase 3a after Phase 3b is active

**Scope:** A methodology bug discovered after Phase 3a committed and Phase 3b ingested one or more 2026 in-season weeks. The 2026 Week 0 baseline produced by Phase 3a is no longer the input Phase 3b's existing Week 1+ rows were computed from; downstream rows are stale.

**Approach per ADR-0015:** cascade-delete. Delete Phase 3b's 2026 weeks > 0, re-run Phase 3a (which produces a new 2026 Week 0 baseline), then re-enqueue post-game jobs for the deleted weeks via the standard Phase 3b drain path. Reuses Phase 3b's normal processing logic rather than maintaining a separate rewind script.

**Procedure:**

1. **Backup branch:** `neonctl branches create --name pre-3a-rerun-<YYYY-MM-DD>`.
2. **Cascade-delete Phase 3b's 2026 in-season rows** — the rows Phase 3a does *not* own (season 2026, `week > 0`). Phase 3a owns only `(2026, week = 0)`, so this never touches the baseline:
   ```sql
   BEGIN;
   DELETE FROM team_week_stats WHERE season_id = (SELECT id FROM season WHERE year = 2026) AND week > 0;
   DELETE FROM game            WHERE season_id = (SELECT id FROM season WHERE year = 2026) AND week > 0;
   -- plus play / drive for (2026, week > 0) once Phase 3b populates them
   COMMIT;
   ```
3. **Re-run Phase 3a:** `cd scripts/backfill && uv run build.py`. Its scoped reload rewrites 2021-2025 + the 2026 Week-0 baseline and never touches 2026 `week > 0` (step 2 already cleared those), producing the corrected baseline.
4. **Re-enqueue the cleared 2026 weeks** via Phase 3b's standard drain path — insert a `job_queue` row per cleared post-game week and let the cron reprocess them (ADR-0016). This reuses Phase 3b's normal processing rather than a bespoke rewind; the concrete `job_queue` insert shape lands with the Phase 3b cron handler.
5. **Verify:** `node scripts/verify-phase3a.mjs` for the Phase 3a portion (`21 PASS / 0 FAIL`); Phase 3b's own verification covers the re-ingested weeks.

If cascade-delete happens more than once or twice in v1, ADR-0015 calls for a dedicated rewind script; premature otherwise.

## Future procedures

Procedures for tables introduced in later slices land here as the slices ship:

- **Slice 4 (player-level ingestion):** correcting `player_game` stats (with implied re-roll of `player_season_stats` and recomputation of `season_to_date_*` columns for all subsequent games in the season — per ADR-0011's maintenance note); reconstructing `player_team_membership` after a mid-season trade is corrected; admin UI procedures for `player_injury` / `player_injury_status` per ADR-0017.

- **Slice 5 (Odds API):** correcting line snapshots after a sportsbook publishes a delayed correction; reconciling `oddsApiEventId` for games where The Odds API and nflverse disagree on event identity.

- **Slices 6-9 (page slices):** typically no new corrective procedures, since page slices consume analytical data rather than ingesting it. Exceptions documented as encountered.

Procedures are added to this runbook when the corresponding implementation lands, not preemptively. An empty procedure section with a TODO is better than a speculative procedure that doesn't match the eventual code shape.
