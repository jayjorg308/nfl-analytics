# ELO application notes and tie-handling correction (amends ADR-0014)

This ADR amends ADR-0014 (v1 ELO methodology, consolidated). Three points
surfaced while implementing the ELO chain in Slice 3 Chunk 3: one is a genuine
correction to ADR-0014's prose, two are application clarifications it left
unpinned. ADR-0014's original body is preserved unchanged — this record carries
the corrections, following the house convention that an amendment is a new
numbered ADR declaring what it amends (as ADR-0019 amended ADR-0016, and ADR-0014
itself superseded ADR-0004) rather than an inline edit.

## 1. Tie handling — correction (`mov_multiplier = 1`)

ADR-0014's tie paragraph is internally inconsistent. It states the **outcome**
correctly — a tie *"collaps[es] the update to the standard `K·(S_actual −
S_expected)`"* — but justifies it with reasoning that produces the **opposite**
outcome: *"the `ln(0 + 1)` numerator is 0."* A zero numerator makes the entire MOV
multiplier zero, which **zeroes the whole update**, rather than collapsing it to the
standard one. For the stated outcome to hold, the multiplier must be **1**.

**Correction:** for a tie, `mov_multiplier = 1`, giving the standard no-margin
update `K·(0.5 − S_expected)` for both teams. This is also the analytically correct
behavior: a tie between unequal teams should nudge their ratings toward each other
(the underdog overperformed), which a zeroed update would freeze.

This bug survived ADR-0014's drafting precisely because the *stated outcome* was
right and only the *justification* was broken — a contradiction prose can hold but
code cannot, which is why implementing it surfaced it.

**The "nominal winner" convention is now vestigial.** ADR-0014 introduced "treating
the lower-pre-game-ELO team as the nominal 'winner' with `score_diff = 0`" solely to
keep the autocorrelation denominator evaluable. The `mult = 1` short-circuit never
evaluates that denominator, so the convention is retired — it is not carried into
the implementation.

**Affected games:** four real regular-season ties in the 2021-2025 backfill window —
DET-PIT (2021 wk10), IND-HOU (2022 wk1), WAS-NYG (2022 wk13), GB-DAL (2025 wk4) — so
this propagates into the 2026 Week-0 baseline Phase 3b consumes; it is not
hypothetical.

## 2. MOV autocorrelation term includes home-field (clarification)

ADR-0014 describes `winner_elo_diff` as "the pre-game ELO gap from the winner's
perspective" without pinning whether home-field is included. The implementation uses
the **home-field-adjusted game ratings** (winner game-Elo minus loser game-Elo) — the
same adjusted ratings the win-probability term uses. The effect is small (e.g. the
2021 opener's multiplier is 3.334 with HFA vs 3.258 without).

**Pre-publication verification flag.** Include-HFA is adopted now on asterisk-
avoidance grounds (match the cited standard exactly, as with the two-point exclusion
in ADR-0020). But the claim that this *matches FiveThirtyEight* is **not yet verified
against 538's published methodology** — it must be checked against 538's source
(their methodology posts / GitHub) before the `/research/elo-methodology` piece
publishes. If 538 used raw (non-adjusted) ratings in the autocorrelation term, either
switch to match or document a deliberate deviation: the asterisk-avoidance only works
if the "matches 538" claim is true. This is a pre-publication gate, not a Chunk 3
blocker.

## 3. Neutral-site home-field is zero (clarification)

ADR-0014 adds 50 rating points to "the home team." At a neutral site there is no team
with home advantage, so **HFA = 0**. "Home team" means *the team with actual home
advantage*; the Super Bowl is always neutral, and international games are neutral per
the schedule's `location` field.

Verified across 2021-2025: 32 neutral games (no null locations) — 26 regular-season
(international), 5 Super Bowls, and 1 wild-card game. The total being far above 5
confirms international games are correctly labeled `Neutral` rather than mislabeled
as home (which would have applied erroneous HFA); the lone neutral wild-card game
confirms the rule already covers a neutral-site playoff case, not just the SB.

## Cross-references

- ADR-0014 — the methodology this amends (original body preserved there).
- ADR-0021 — playoff `teamWeekStats` representation (the ELO chain's storage shape).
