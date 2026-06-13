# Phase 3a backup-branch sequencing: backup-first (amends ADR-0015)

ADR-0015's prod-safety section specifies the named Neon backup branch is created "after
the Slice 1 hand-seeded cleanup DELETE and before Phase 3a runs," so that "restoration
returns to a clean pre-backfill state, not to the Slice 1 final state." This ADR reverses
that sequencing: the backup branch is created **first** — before the hand-seed cleanup —
capturing the validated, shipped Slice 1 prod state. ADR-0015's body is preserved; this
records the corrected sequencing.

The reversal surfaced reconciling ADR-0015 against the Chunk 4 code path
(`build.py --cleanup-2024` does the cleanup and the write in one invocation, so a backup
cannot sit between them in a single-shot run) and against the runbook.

## Why backup-first

1. **The post-cleanup state is empty, not "ready for Phase 3a."** Slice 1 seeded only the
   2024 season, so the hand-seed DELETE leaves the analytical store empty. ADR-0015's
   "after the DELETE" backup therefore captures an empty database — a state that never
   independently existed and is useless as a restore target.

2. **`build.py`'s idempotency removes the need for a clean-start backup.** The
   transaction-wrapped scoped truncate-and-reload re-runs correctly from any state, so the
   "restore to a clean slate to re-run" rationale does not hold — re-running overwrites
   regardless of starting state.

3. **Backup-first captures the last validated, shipped state** (Slice 1's working 2024
   dashboard). That is the meaningful "revert to what we shipped" target, and it is
   strictly more recoverable than the empty state: an operator can always delete a Slice-1
   backup down to empty, but cannot recover Slice 1 from an empty backup.

4. **It aligns with the runbook's General Principle #1** — "Backup branch first … captures
   the pre-write state." ADR-0015's after-cleanup timing was a special-case deviation from
   the discipline the runbook otherwise mandates; backup-first harmonizes them.

## Atomic cleanup + write

To make backup-first safe, `build.py --cleanup-2024` runs the hand-seed cleanup and the
backfill write in a **single transaction**. A write failure rolls back the cleanup too,
leaving prod at its prior (Slice 1) state rather than the empty post-cleanup state. The
backup branch is the explicit "revert to shipped" recovery target, not the mechanism
saving the operator from a half-completed run — the atomic transaction handles the
half-run case on its own.

## Resolved prod-run sequence (Chunk 6)

1. Hand-verify ≥3 games' MOV-ELO per ADR-0012 #4 (the five-game package — including the
   tie and a non-neutral playoff game — covers every ADR-0014/0022 ruling). **Signed off.**
2. **Named backup branch `pre-phase3a-<YYYY-MM-DD>`**, capturing the validated Slice 1
   prod state — created *before* the cleanup.
3. `build.py --cleanup-2024` against the prod `DATABASE_URL` (atomic cleanup + write).
4. `DATABASE_URL=<prod> node scripts/verify-phase3a.mjs`, diffed against the known-good dev
   output. An empty diff confirms prod matches the validated dev backfill. A non-empty
   diff: rule out an environmental artifact (the verifier is scoped to the three Phase 3a
   tables) before concluding the write was wrong.

## Cross-references

- ADR-0015 — Phase 3a scope / idempotency / prod-safety (original after-cleanup sequencing
  preserved there; backup *timing* amended here).
- ADR-0012 #4 — the hand-verification ship criterion gating step 1.
- The runbook's General Principle #1 (backup-first), which this aligns ADR-0015 with.
