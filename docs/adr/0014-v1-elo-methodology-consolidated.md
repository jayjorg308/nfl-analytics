# v1 ELO methodology (consolidated)

Supersedes ADR-0004. This ADR consolidates the full v1 ELO methodology — formula, constants, chain initialization, inter-season regression, playoff handling, tie-game handling, warm-up caveat, and tunability posture — in one canonical record. The MOV reversal that motivated the supersession is documented here alongside the rest of the methodology so future readers (and the methodology piece at `/research/elo-methodology`) have a single source of truth.

> **Note (2026-06-18):** the planned `/research/elo-methodology` piece was subsequently **cut** (see [ADR-0010](0010-v1-build-sequence.md)'s 2026-06-18 update; Slice-3 decision #11). This ADR — together with ADR-0021 and ADR-0022 — now stands as the canonical methodology documentation in the piece's place. The methodology content below is unaffected.

## Formula

Each game updates both teams' ELO using the standard formula `K * (S_actual - S_expected)` where `S_actual` is 1 for a win, 0.5 for a tie, and 0 for a loss, and `S_expected = 1 / (1 + 10^((opponent_elo - team_elo + home_field_advantage) / 400))`. Home-field advantage is **50 rating points** added to the home team's effective rating for the win-probability calculation, inherited from FiveThirtyEight's NFL ELO as a v1 default. Like `K = 20` and the MOV constants, refinable after a full 2026 season of evaluation data. `K` is fixed at **20** across regular season and playoffs.

The update is then multiplied by the FiveThirtyEight margin-of-victory factor: `margin_multiplier = ln(|score_diff| + 1) * 2.2 / ((winner_elo_diff * 0.001) + 2.2)`, where `score_diff` is the absolute scoring margin and `winner_elo_diff` is the pre-game ELO gap from the winner's perspective (positive when the higher-rated team won, negative on upsets). The autocorrelation correction in the denominator is load-bearing — it prevents the runaway feedback loop where strong teams over-accumulate rating from blowing out weak opponents. The 2.2 and 0.001 constants are inherited from 538's NFL tuning as v1 defaults; tunable after a full 2026 season of real predictions produces evaluation data. Same tunability posture as `K = 20` and the inter-season regression factor: defensible defaults, refinable with real-data evidence.

## MOV reversal from ADR-0004

ADR-0004 deferred MOV to v2 on the reasoning *"adds complexity without proportional payoff for v1's analytical claims."* This ADR reverses that call. The decisive argument is **methodology lock-in**: Phase 3a (see ADR-0008 and ADR-0015) is the inflection point at which the v1 ELO chain becomes durable. Reversing later means republishing ~2,720 ELO values (silent methodology change, breaks any external links), maintaining parallel non-MOV/MOV columns (schema bloat, dashboard ambiguity), or forking at the v2 boundary (discontinuity on the trajectory chart that team-strength stories depend on). All three are worse than including MOV now. The methodology piece at `/research/elo-methodology` is also materially stronger with MOV — the autocorrelation correction is a substantive analytical hook that distinguishes the piece from "I used the textbook formula." Within the NFL ELO community (538, ESPN's FPI, Massey ratings) MOV is closer to table stakes than to advanced refinement, and the implementation cost is three additional arithmetic operations per update.

## Chain initialization

ELO is iterative; the chain has to start somewhere. The N = 5 seasons backfill per ADR-0008 begins at 2021 Week 0 with **all 32 teams at 1500**. The chain iterates 2021 → 2022 → 2023 → 2024 → 2025 with the formula above, terminating with the 2026 Week 0 baseline that Phase 3b's first cron consumes.

Cold start was chosen over seeding from FiveThirtyEight's published 2020 final values because the portfolio audience for this project is people evaluating engineering judgment, for whom **reproducibility-from-scratch is a stronger signal than convention-adoption**. A reader can replicate the entire chain from the formula and `K = 20` alone, with no external archive lookup. Departing from the community-standard seed *with explicit reasoning* is more sophisticated engineering than adopting the seed quietly. Additionally, 538 is winding down and its archive may not persist indefinitely; methodology built on it has fragile provenance.

## Inter-season regression

At each season boundary (2021→2022 through 2025→2026), each team's final ELO from the prior season is **regressed 1/3 of the way toward 1500** — the same rule inherited from ADR-0004's original framing. Regression applies to each team's *last-played-game ELO*: for playoff teams that's their final playoff game's rating (wild card through Super Bowl, whichever was last); for non-playoff teams that's their Week 18 rating. Regression captures offseason roster turnover that pure iteration cannot.

## Playoff and tie handling

Playoff games update ELO with the same `K = 20` and MOV formula as regular-season games — **no playoff K bump**. The NFL plays only 13 playoff games per season; bumping K would let a small number of games disproportionately reshape ratings, adding noise. (NBA-style playoff K bumps don't translate to NFL where regular-season games are already played mostly all-out.)

Tie games (rare but possible) compute the margin multiplier by treating the lower-pre-game-ELO team as the nominal "winner" with `score_diff = 0`. This keeps the autocorrelation denominator term well-defined; the `ln(0 + 1)` numerator is 0, collapsing the update to the standard `K * (S_actual - S_expected)` evaluation with `S_actual = 0.5` for both teams. The choice of nominal winner doesn't affect the symmetric update; it's a documented convention to make the formula evaluable in the edge case.

## Warm-up caveat

The 5-season chain has two distinct milestones. **Differentiation from 1500** emerges from noise by ~Week 12 of 2021 as the cold-start chain begins to diverge with MOV-amplified early swings. **Analytical validity for cross-season comparison** stabilises by ~2023. ELO values for 2021 and 2022 are warm-up artifacts and **should not be used for cross-season strength comparison**. They exist because they are computationally necessary to produce the 2026 Week 0 baseline, not because they are analytically meaningful in isolation. Future research investigations that want pre-2023 ELO trajectories should regenerate an extended chain (e.g. starting from 2017) at the time the need surfaces; doing so up-front for v1 would extend Phase 3a's scope without payoff against any view shipped in v1.

## Implementation locus

Phase 3a (the local Python backfill — see ADR-0008 and ADR-0015) computes the chain 2021 → 2026 Week 0 in one run. Phase 3b (the Vercel cron — see ADR-0016) consumes the Week 0 baseline and produces in-season `teamWeekStats` rows iteratively. The formula is the same across phases; Phase 3a runs in pandas, and Phase 3b's implementation choice (TypeScript in-memory vs another shape) is determined during Phase 3b construction.

Hand-verification of 3 games' ELO outcomes (ADR-0012 ship criterion #4) covers the full pipeline including the MOV multiplier. The worked example feeds this ADR's "is the math right" check. (It was also to have fed the methodology piece's narrative example; that piece is now cut — see the 2026-06-18 note above — so the worked example serves the ADR-as-documentation alone.)
