# Write-once forward ingestion and the completeness gate — amends ADR-0016

ADR-0016 settled Phase 3b's trigger and retry mechanics but left one question unaddressed: nflverse revises play-by-play after initial release (correcting attributions, recalibrating model outputs), so does Phase 3b ever re-process a week to settle those revisions, or does it ingest each week once and freeze? This ADR decides **write-once**, and specifies the **completeness gate** that makes write-once safe. ADR-0006's freshness contract is preserved unchanged — this governs whether already-ingested weeks are revisited, not when first ingestion fires.

## The three postures

- **Write-once** — ingest each week from the first *complete* parquet release (ADR-0016's existing trigger), never revisit. Model outputs are frozen at their first-complete-release values, before any later nflverse revisions.
- **Settle-window** — ingest provisionally for freshness, then re-ingest once after a settle window to capture revised values, then freeze.
- **Re-ingest-indefinitely** — always re-pull the latest, so the same week's numbers change over time.

Re-ingest-indefinitely is rejected outright: it makes dashboard EPA non-deterministic across time and fights ADR-0007's snapshot framing. The real choice was write-once vs settle-window.

## Why write-once

**Coherence with ADR-0018's Volatility test.** ADR-0018 captures base model outputs eagerly at ingestion *because* a late backfill samples a different pipeline run and cannot reproduce row-internal consistency. Settle-window would re-pull settled values weeks later — which is exactly the late re-pull that makes model outputs nearly as backfillable as descriptors, draining the Volatility test of its force. Settle-window pays machinery cost to weaken the very rule that justifies eager capture; write-once and eager capture point the same direction.

**Credibility semantics.** Settle-window means the *same week's* EPA silently changes between Monday and the settle date — a harder "why did Week 5's edge change?" question than write-once's stable as-ingested semantics. Under ADR-0007 the working dashboard is `live` and may change as *new games* arrive; changing because of *silent upstream revision* is not legible the same way.

**The teamWeekStats cascade stays rare.** Because each `teamWeekStats` row is season-to-date through its week, re-ingesting an earlier week's plays would force a recompute of every later week — promoting the rare, operator-initiated cascade (ADR-0011 manual override, ADR-0015 cascade-delete) into a routine, every-week automated pipeline stage. Write-once keeps that cascade an exceptional recovery procedure, not a standing cost.

**Corroboration and scope.** ADR-0017 already classifies nflverse play-by-play as high-quality with a low rate of post-release corrections, so the fidelity gap write-once accepts is small — and it is smallest exactly where v1 lives (team-level aggregates), since the largest revisions are participation / attribution fixes that matter most for player-level data, which is out of v1 scope (ADR-0015). Settle-window would spend real complexity where v1's fidelity needs are weakest.

**Reversibility.** Write-once is not a trap. If forward measurement (below) or real use shows the fidelity cost is material, settle-window is the documented v2 upgrade, and the durable parquet still supplies settled values for a later re-pull.

## The completeness gate makes write-once safe

Write-once's one real failure mode is freezing a parquet release that is *present but incomplete* (a game's plays partially loaded). ADR-0016's retry covers *non-arrival*, not partial-arrival; the gate closes that hole, and — critically — does so by routing into ADR-0016's *existing* retry path rather than adding new machinery.

- **Primary check — score reconciliation.** Sum each team's scoring-play points across the game's plays and compare to the final score already on the `game` row. A mismatch means the plays do not reconstruct the game — plays are missing. This is a true completeness invariant, not a heuristic.
- **Secondary checks** — every completed `game` has play rows; a per-game play-count floor (~100, tuned at implementation) catches grosser truncation.

A failed gate marks the work not-yet-ingestible and re-enqueues it through ADR-0016's `not_before` / exponential-backoff path — **one retry mechanism, two triggers** (non-arrival and partial-arrival). The 5-attempt / ~31h cap is unchanged; if plays still do not reconcile after the window, that is a genuine upstream problem warranting human attention, exactly as ADR-0016 intends.

## Pre-registered 2026 forward validation

Write-once accepts a small, *asserted* fidelity cost; reproducibility says measure it rather than assert it. The measurement cannot run now — in the June offseason no provisional 2025 parquet operand exists (nflverse overwrites the rolling file in place, so the provisional release is gone), and the EPA aggregation engine that would consume it is Phase 3a's own deliverable. So the check is pre-registered as a one-time exercise during 2026 Phase 3b's first live weeks: archive a provisional Monday parquet, re-pull the same weeks settled ~2 weeks later, and diff the **cumulative season-to-date** team EPA/play (the quantity the dashboard renders, where revision deltas accumulate if they accumulate at all).

Pre-committed interpretation: a delta below ~0.01 EPA/play confirms write-once timing; a surprisingly large delta reopens *timing only* — whether the single write-once ingest should wait for a more-settled release, traded against ADR-0006's Monday freshness contract. It does **not** reopen settle-window, which the coherence argument rejects regardless of the delta.

## Consequences

- Dashboard and `teamWeekStats` EPA reflect nflverse's first-complete-release values, frozen — internally pipeline-consistent, not chasing later revisions. A deliberate, recorded choice, not an oversight.
- The completeness gate is the load-bearing safety mechanism; without it, write-once's partial-arrival hole would be open. It reuses ADR-0016's retry rather than introducing a second control path.
- Settle-window is the documented v2 fidelity upgrade should forward validation or real use show write-once's cost is material.
