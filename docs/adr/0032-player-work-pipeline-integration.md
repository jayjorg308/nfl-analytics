# Player-work pipeline integration: fold per-game player facts into `ingest_game`

Slice 4 (ADR-0010) adds player-level ingestion. ADR-0031 settled the player-data *source* and
identity resolution; this ADR settles **where the per-game player-fact work runs in the Phase 3b
pipeline** — the tier-1 integration. It does **not** decide opponent-rank placement (§7).

Player work splits along the **same dependency boundary ADR-0026 already drew**, not a new one:
per-game player **facts** (the `playerGame` rows — shares, yards, `seasonToDate*`, plus the
ADR-0031 player ensure-exists upsert) depend on **only the game's own plays**, which is exactly
`ingest_game`'s unit of work and completeness boundary; the opponent-defense-rank denormalisation
depends on the cross-team ranking `aggregate_week` produces (tier-2). So the tier-1 question is
narrow: do the per-game facts **fold into `ingest_game`** or ride a **parallel per-game job**?

This ADR **builds on** ADR-0026 (two-tier unit of work), ADR-0028 (the `playsFrozenAt` marker +
the all-games-frozen enqueue precondition), ADR-0027 (idempotency-by-construction), ADR-0019 (the
plays-only completeness gate), ADR-0031 (the player upsert shape), and ADR-0030 (`maxDuration =
300` coupled to `DRAIN_BUDGET_MS`). It **refines ADR-0028**'s marker meaning (§4).

## Decision

**Fold per-game player facts into `ingest_game` (extend tier 1).** No new job type, no discovery
precondition, no arm added to the payload discriminated union.

- **The play-writes transaction is UNCHANGED** — it still commits `game` / `drive` / `play`
  *before* the gate, independent of the gate verdict (the ADR-0028 §1 / "trap #2" structure:
  partial plays can be committed for a gate-failed game and corrected on a later parquet).
- **A NEW post-gate transaction, atomic**, runs only on gate-pass:
  `{ player ensure-exists upserts (ADR-0031 DO NOTHING) + playerGame fact writes + SET
  playsFrozenAt }`.

Rejected alternatives (from the fork): **B** — a parallel `aggregate_player_game` job — and
**C** — a per-week `aggregate_player_week` job. Both re-read the game's plays from Postgres,
where `ingest_game` already holds them in memory (the decisive cost difference, §3); both add a
job type + (B) a discovery precondition for a dependency the per-game facts do not have; and B's
separate retry lineage buys nothing because there is no expensive or non-idempotent fact work a
coupled retry would wastefully repeat (§2). C additionally forces per-game facts — which have no
per-week dependency — to wait on the whole week's aggregate.

## Ordering, and why post-gate

Player facts must **not** join the play-writes transaction. That transaction commits *before* the
completeness gate, so folding facts into it would materialise `targetShare` / `rushAttemptShare` /
`airYardsShare` and `seasonToDate*` from **possibly-incomplete plays**, for a game that **may
still fail the gate** — wrong denominators written and then stranded. Post-gate,
atomic-with-the-marker, is the only correct placement:

```
step 6  play-writes tx            (UNCHANGED — commits pre-gate, independent of gate verdict)
step 7  completeness gate         (plays-only: score reconciliation + play-count floor, ADR-0019)
step 8  NEW post-gate tx (atomic) { player ensure-exists + playerGame writes + SET playsFrozenAt }
```

**Failure semantics.** If the player-agg step throws, the marker is never set → the game reads
un-frozen → discovery re-mints it → retry. This is **correct**: a frozen-but-player-less game
would break the tier-2 opponent-rank work, so player-agg success *should* gate the freeze. The
gate **check** stays plays-only (ADR-0019 unchanged); player-agg is a **required post-gate write**,
not a gate condition. Idempotency holds: the player upsert is conflict-tolerant on `gsis_id`
(ADR-0031) and the `playerGame` write is a conflict-tolerant upsert, so a coupled retry re-runs
all of step 8 harmlessly — which is why B's isolated retry lineage protects nothing.

**`seasonToDate*` ordering (build-time note, not a hazard).** The running totals read the
player's **prior-week** `playerGame` rows. Safe by two facts: forward write-once guarantees weeks
`< N` are frozen before week `N` ingests, and a player has ≤1 game per week, so the drain's
parallel `FOR UPDATE SKIP LOCKED` claims create no within-week race. Recompute-from-source stays
drift-free under retry and the ADR-0015 cascade.

## `playsFrozenAt` redefinition — a load-bearing benefit, not a side effect

Because step 8 is atomic, `playsFrozenAt` now means **plays-complete AND per-game player facts
materialised** (previously: plays-complete only, ADR-0028 §1). This is **desirable**: ADR-0028
§5's `aggregate_week` enqueue precondition is "enqueue once **all** of the week's games are
frozen." Under the richer meaning, that precondition now *also* guarantees **every `playerGame`
row for the week exists before `aggregate_week` runs** — which is exactly what the tier-2
opponent-rank denormalisation (§7) needs, since it writes *onto* `playerGame`. Folding therefore
**strengthens** the precondition for tier-2 for free.

The alternative — keep `playsFrozenAt` plays-only and write player facts in a separate
post-marker step — is strictly worse: `aggregate_week` could then fire before the player facts
exist, breaking tier-2. The atomic-with-marker meaning is the one to carry.

The marker **mechanism** is untouched — discovery still reads `game.playsFrozenAt` (ADR-0028 §1,
§5 step 2); same column, same index, same set-once `COALESCE` write. Only the *meaning* widens, so
this **refines ADR-0028** (§4 records the required back-reference note).

## Cross-ADR note (required, §5 discipline)

A dated note is added to **ADR-0028** — at both **§1** (marker semantics) and **§5** (the
all-games-frozen enqueue precondition) — recording that, from ADR-0032, `playsFrozenAt` /
"frozen" includes per-game player facts. Without it a reader of 0028 keeps the old plays-only
meaning. This is the same amends/refines back-reference discipline applied to ADR-0018 (by
ADR-0031) and ADR-0026 (by ADR-0028): a refinement lands a note on the refined ADR, it does not
merely live in the new one.

## The measured sizing (why folding is safe against the 300s ceiling)

The hard correctness bound is a **single `ingest_game` wall-time < 300s** (`maxDuration`,
ADR-0030) — *not* `300 − 30`; the 30s `DRAIN_HEADROOM_MS` governs throughput (it stops *claiming*
new jobs at 270s), not a single job's ceiling. Measured against the **real production reader**
(hyparquet-over-HTTP with the exact `PBP_COLUMNS` projection, ADR-0029 — *not* the Python backfill
reader, which never runs in the handler), for the heaviest game (most play rows) in three seasons:

| Season | Heaviest game | Plays | Pull + parse | Filter | Player-agg delta |
| --- | --- | --- | --- | --- | --- |
| 2024 | TB@CAR | 211 | 1938 ms | 9 ms | 0.035 ms |
| 2023 | BUF@PHI | 218 | 1847 ms | 8 ms | 0.045 ms |
| 2022 | IND@MIN | 240 | 1787 ms | 8 ms | 0.051 ms |

A single `ingest_game` runs ≈ **2 s** (pull ~1.85 s dominant; filter ~8 ms; player-agg ~0.05 ms;
plus small DB writes) — **~100× under the 300s ceiling**. Player aggregation adds ~0.003% of the
pull; the throughput hit (games per drain window) is effectively zero.

**Caveat (verification honesty):** this is a **2022–2024 worst-case proxy**, not live 2026 volume
(`play` is empty in every DB during the offseason, so a live number cannot be had until Week 1).
The hard live measurement rides `docs/phase-3b-go-live-checklist.md` as a first-live watch-item.
DB writes were excluded from the bench (no DB) but are small (~180 play rows already written +
~20 `playerGame` + ~20 player upserts) and present with or without folding.

## Cost-attribution note (prevents future misattribution)

The ~1.85 s pull is paid **per game** because `readGamePlays` re-pulls the whole-season pbp parquet
on each call (the v1-lean in-memory filter; row-group predicate pushdown on `game_id` is deferred,
ADR-0026 / ADR-0029). If a future budget conversation ever tightens, **that** — the
season-pull-per-game — is the lever, **never** the folded player-agg (which is 0.003% of the pull).
Recorded so a later reader does not misattribute per-job cost to the player work this ADR adds.

## Out of scope — opponent-rank placement (fork iii)

This ADR settles **tier-1 per-game facts only**. The opponent-defense-rank denormalisation is
**deliberately deferred to fork (iii)**, because its *which-week* choice is a product call:
**rank entering the matchup** (week N−1's finalized ranks, which already exist when week N's
`ingest_game` runs → the rank *could* co-locate with the folded facts) vs. **rank after** (week
N's ranks → must be a post-`aggregate_week` step). The tier-1 facts decision is **A regardless of
which way that goes**; fork (iii) decides only where the rank field attaches and when.

## Build-time obligations (Slice 4)

Two obligations this ADR creates that land when the fold is actually built:

- **`playerGame` must be deleted with its `game` — a correctness requirement, not tidiness.**
  Because `playsFrozenAt` now certifies `playerGame` rows exist, a cascade-delete (ADR-0015
  recovery / the ADR-0028 §1 marker-dies-with-`game` → re-mint → re-ingest) that leaves a
  `playerGame` row behind orphans any player who was in the bad ingest but not the re-ingest (the
  upsert overwrites matching `(game_id, player_id)` rows but never removes vanished ones). Note
  the repo does **not** use FK `ON DELETE CASCADE` — `play` / `drive` reference `game` with plain
  FKs and are removed by the runbook's **explicit ordered DELETE** sequence (`docs/runbook.md`,
  which already lists play/drive as pending once Phase 3b populates them). So `playerGame` inherits
  nothing automatically: the Slice-4 migration must add `playerGame` (for `2026, week > 0`) to that
  runbook DELETE sequence, deleted **before** `game`. The `player` *dimension* correctly does not
  cascade (shared, like `team` — ADR-0031 ensure-exists).
- **Update the `playsFrozenAt` comment in `db/schema.ts` when the fold ships.** It currently
  describes the marker as plays-only (correct as-built — the fold is unbuilt). When step 8 lands,
  widen it to the plays-complete-AND-player-facts meaning this ADR establishes, so the deferral
  does not rot into stale plays-only text.

## Cross-references

- **ADR-0026** — the two-tier unit of work this extends without adding a tier or a job type.
- **ADR-0028** — the `playsFrozenAt` marker + all-games-frozen precondition; this ADR **refines**
  their meaning to include per-game player facts (dated note added at §1 and §5).
- **ADR-0027** — the ensure-exists / idempotency-by-construction the folded step reuses.
- **ADR-0019** — the plays-only completeness gate, unchanged; player-agg sits *after* gate-pass.
- **ADR-0031** — the player-identity source + the `DO NOTHING` ensure-exists upsert folded here.
- **ADR-0030** — `maxDuration = 300` (the single-job ceiling the sizing is checked against).
- `docs/phase-3b-go-live-checklist.md` — carries the first-live hard measurement watch-item.
