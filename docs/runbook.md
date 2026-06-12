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

> **TODO: filled in during Slice 3 implementation once Phase 3a's ELO computation logic exists.** The procedure depends on having a callable "recompute ELO from game N forward" function — which lands as part of Phase 3a's Python script and Phase 3b's TypeScript handler. Until both exist, manual recomputation is theoretically possible but error-prone enough to not document as a routine procedure.

### Correcting `team_week_stats` values

**Scope:** EPA aggregates wrong (upstream play-level data was corrected and the rollup is stale), SOS values wrong, traditional stat aggregates wrong. Does *not* cover ELO corrections — those go through the game-outcome procedure above because ELO is iterative.

**Downstream impact:** `team_week_stats` is read by the Slate Dashboard's `weekSummary` view directly. Corrections take effect immediately on next page render. Per ADR-0011, the materialised values on `playerGame` (`opponentDefenseRankPass/Rush`) reference `team_week_stats` at time of ingestion — historical corrections to `team_week_stats` do not auto-propagate to `playerGame`, and a separate cascade is documented as an admin operation when `playerGame` data exists.

> **TODO: filled in during Slice 3 implementation.** The procedure body lands once Phase 3a has produced real values and the shape of "typical correction" is understood. Premature documentation risks specifying a procedure for a column shape that hasn't materialised yet.

### Re-running Phase 3a after Phase 3b is active

**Scope:** A methodology bug discovered after Phase 3a committed and Phase 3b ingested one or more 2026 in-season weeks. The 2026 Week 0 baseline produced by Phase 3a is no longer the input Phase 3b's existing Week 1+ rows were computed from; downstream rows are stale.

**Approach per ADR-0015:** cascade-delete. Delete Phase 3b's 2026 weeks > 0, re-run Phase 3a (which produces a new 2026 Week 0 baseline), then re-enqueue post-game jobs for the deleted weeks via the standard Phase 3b drain path. Reuses Phase 3b's normal processing logic rather than maintaining a separate rewind script.

> **TODO: filled in once Phase 3a and Phase 3b infrastructure exist.** The procedure references the `job_queue` table (Slice 3 migration) and the Phase 3b dispatch surface (Slice 3 cron handlers); both must exist before the cascade-delete steps can be enumerated concretely.

## Future procedures

Procedures for tables introduced in later slices land here as the slices ship:

- **Slice 4 (player-level ingestion):** correcting `player_game` stats (with implied re-roll of `player_season_stats` and recomputation of `season_to_date_*` columns for all subsequent games in the season — per ADR-0011's maintenance note); reconstructing `player_team_membership` after a mid-season trade is corrected; admin UI procedures for `player_injury` / `player_injury_status` per ADR-0017.

- **Slice 5 (Odds API):** correcting line snapshots after a sportsbook publishes a delayed correction; reconciling `oddsApiEventId` for games where The Odds API and nflverse disagree on event identity.

- **Slices 6-9 (page slices):** typically no new corrective procedures, since page slices consume analytical data rather than ingesting it. Exceptions documented as encountered.

Procedures are added to this runbook when the corresponding implementation lands, not preemptively. An empty procedure section with a TODO is better than a speculative procedure that doesn't match the eventual code shape.
