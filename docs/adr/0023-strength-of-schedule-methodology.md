# Strength-of-schedule (`sosRank`) methodology

`teamWeekStats.sosRank` had no defined formula. This ADR pins it, for the same
methodology-lock-in reason as EPA (ADR-0020) and ELO (ADR-0014): the value becomes
durable at Phase 3a, so the definitional choices belong in the record, not implicit
in the backfill code. SOS reuses the ELO chain ADR-0014 produces.

## Definition

`sosRank` is a team's rank — **1 = hardest** — among all 32 teams by **cumulative
average opponent ELO faced to date**. Each opponent contributes its **raw pre-game
ELO at the moment that game was played** (point-in-time; raw = no home-field
adjustment, since HFA is a game-location effect, not a measure of opponent quality).
The average is a simple equal-weight mean over the games a team has played through
week N; bye weeks carry forward (no new opponent, so the average is unchanged). Only
the integer rank is stored — the continuous average is computed, used to rank, and
discarded (the schema carries `sosRank` only).

## Point-in-time, not hindsight

Each opponent is scored at its strength *when played*, not its end-of-season or
current strength. There are two independent reasons, and both belong here so a future
reader does not reopen this as "they settled for the easy one":

1. **They measure different questions.** Point-in-time answers *"how hard was your
   schedule given what was known when you played it"* — scheduling difficulty.
   Hindsight (end-of-season opponent ELO) answers *"how good were your opponents
   really"* — retrospective opponent quality. The dashboard's SOS-on-a-card is a
   forward-looking "how tough has this team's road been" read, which is the
   scheduling-difficulty question. So point-in-time is the **right measure on its own
   terms**, not a compromise.

2. **Hindsight is uncomputable for the live product.** Phase 3b computes
   `teamWeekStats` weekly; a week-N SOS using opponents' end-of-season ELO cannot be
   known until the season ends, so it would force the Phase 3a backfill and the
   Phase 3b cron onto *different* SOS definitions — a methodology discontinuity at the
   2025/2026 boundary, the exact thing Phase 3a exists to prevent. This is the same
   coherence logic as write-once over settle-window (ADR-0019).

A third reading — opponent ELO *as of the snapshot week N* — is also rejected: it
makes a team's already-played schedule difficulty drift every week as past opponents
play on, which is both surprising and expensive. Only point-in-time is stable,
incremental, and identical across backfill and forward cron.

## Rank direction and the bye-week shift

**1 = hardest** (highest cumulative average opponent ELO). This convention is stated
loudly here and must be stated wherever the dashboard eventually renders it — "rank
1 = toughest schedule" is exactly the kind of convention that gets silently inverted
in display. Ties are broken deterministically on the continuous average before it is
discarded.

The rank recomputes across all 32 teams **every week**. A consequence, intended: a
team on a bye can see its `sosRank` move from one week to the next even though it
played no one and its own average did not change — because the other 31 teams played,
their averages moved, and the rank is relative. This is correct: your schedule-
strength *rank* evolves on your bye because everyone else's schedules did.

## Playoff rows: the regular-season-final rank, carried forward

On playoff-week rows (19-22), `sosRank` is **frozen at the team's week-18 value**.

The justification is a **population-scale** one, and deliberately *not* the
EPA-freeze analogy (ADR-0021) — the mechanism is different. EPA freezes on playoff
rows because regular-season-only EPA is all that exists (ADR-0020); the freeze is a
consequence, not a choice. SOS is not like that: playoff games *have* opponents with
ELOs, so a playoff SOS is perfectly computable. The reason to freeze anyway is that
`sosRank` is a **rank within a 32-team field**, and on a playoff row only 14/8/4/2
teams remain — you cannot re-rank on a comparable scale, because rank-4-of-8 is not
rank-4-of-32. So the stored playoff value is "the regular-season-final, 32-team SOS
rank carried forward," because playoff games cannot enter a 32-team rank once most
teams have stopped playing.

`sosRank` is currently **not rendered** on any surface (it exists in the `week_summary`
view and schema but no component reads it), so the freeze is unremarkable today. If a
future slice surfaces `sosRank` on playoff cards, the "rank among 32 as of week 18"
semantics must be made explicit there, so it is not misread as "rank among the
remaining 8."

## Week 0: a distinct projected metric sharing the column

At week 0 no games have been played, so the realized point-in-time SOS above is
undefined. Week-0 `sosRank` is therefore a **distinct, projected metric** that shares
the `sosRank` column: a team's rank (1 = hardest) by the **average week-0 baseline
ELO of all its scheduled regular-season opponents** — the full 17-game slate, division
rivals counted twice (they are played twice), the team's own rating never entering.
This is the structural analogue of EPA-frozen-on-playoff-rows (ADR-0021): one column,
a different treatment in a structurally different week, **named rather than smoothed**.

It is a deliberate exception to this project's usual rule that backfill and the
Phase 3b cron share one definition. Here they cannot: week 0 has no realized input by
construction, so the week-0 cell *must* be projected and week-1+ cells *must* be
realized. The two meet at the wk0→wk1 boundary, and the seam is real — the week-0
value averages all 17 scheduled opponents (a full-slate projection), while the week-1
value averages the single opponent actually played (a one-game realized sample), so
the rank can swing sharply across that boundary. That is inherent to "realized to
date," not a defect; but the column is not uniform across the seam, and a reader must
know week 0 means *projected* and week 1+ means *realized*.

The **2026 week-0 row is load-bearing**, unlike the historical week-0 rows: it is the
only 2026 `teamWeekStats` row until Phase 3b ingests week 1, so its `sosRank` is the
strength-of-schedule value shown at season start, before any 2026 game is played. The
historical week-0 rows (2021–2025) are quickly dominated by realized SOS as those
seasons play out; the 2026 one stands alone for weeks.

Mechanics, verified in `verify_sos_week0.py` against 2024 and 2026: every team has its
full 17-opponent slate; no game is self-referential; each opponent enters at its
week-0 baseline ELO (the only ELO that exists at week 0); and rank 1 = highest average
opponent ELO = hardest (sign confirmed, not inverted). The 2024 projection tracks
intuition — AFC North teams (CLE, BAL) rank hardest, NFC South teams (NO, ATL) easiest.

## Tunability and cross-references

Average-opponent-ELO is the v1 definition; alternatives (opponent win %, opponent
point differential) are refinements available later, same posture as the ELO and EPA
constants. Cross-references: ADR-0014 (the ELO this consumes), ADR-0020 (EPA, the
sibling per-play methodology), ADR-0021 (playoff-row representation — the freeze
applies here but on different grounds), ADR-0019 (the write-once coherence logic the
point-in-time argument mirrors).
