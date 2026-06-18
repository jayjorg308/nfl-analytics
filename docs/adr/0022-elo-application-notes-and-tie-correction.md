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

**Deviation from 538 (recorded 2026-06-18).** Surfaced while verifying §2 against
`nfl-elo-game/forecast.py`: 538's reference implementation does **not** use `mult = 1`
on a tie. Its `result1 == 0.5` branch sets the MOV denominator to `1.0`, giving
`mult = ln(max(0,1)+1) · 2.2 = ln(2)·2.2 ≈ 1.525`. We use `mult = 1`. So unlike the
HFA-in-MOV structure (§2, a match), **tie handling is a deliberate deviation from 538**.
Recorded here so it is auditable regardless of how it is ever framed in print
(correction-to-538, neutral-deviation, or footnote would be an open authoring decision
with portfolio stakes). The methodology piece that would have made that call is now cut
(see the 2026-06-18 note at the end of §2); the framing question only reopens if
ADR-0012 #2 is re-pointed at an investigation that surfaces tie handling.

**What the `mult = 1` reasoning actually established (honest record, no retrofit).** The
original argument established **"1, not 0" — not "1 beats 1.525."** It was framed entirely
as correcting ADR-0014's *internal* inconsistency: ADR-0014 stated the intended outcome
(collapse to the standard `K·(S_actual − S_expected)`) but its justification (`ln(0+1)=0`)
produced a *zeroed* update instead. `mult = 1` was selected because 1 is the multiplicative
identity that recovers that stated standard update. The analytical "nudge toward each other"
argument rules out `mult = 0` (which freezes unequal teams) but does **not** distinguish 1
from 1.525 — any positive multiplier produces a nudge. 538's 1.525 was never evaluated in
the §1 reasoning. So our position is "1 over 0, with 1 = the identity that restores the base
formula," **not** a demonstrated "1 is superior to 1.525." If the piece wants to frame the
tie deviation as an improvement on 538, that comparison still has to be made — it was not
made here.

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

**Verification — RESOLVED 2026-06-18: structure matches 538's reference implementation.**
Previously adopted on asterisk-avoidance grounds (match the cited standard exactly, as
with the two-point exclusion in ADR-0020) but unverified — resting on recollection of
538's methodology, not their source. Now verified against FiveThirtyEight's published
code, `nfl-elo-game/forecast.py`
(https://github.com/fivethirtyeight/nfl-elo-game/blob/master/forecast.py), fetched from
source. 538 computes the rating gap **once** with HFA folded in, then feeds that *same*
adjusted value into both the win-probability term and the MOV denominator (verbatim):

```python
HFA = 65.0     # Home field advantage is worth 65 Elo points
elo_diff = team1['elo'] - team2['elo'] + (0 if game['neutral'] == 1 else HFA)
game['my_prob1'] = 1.0 / (math.pow(10.0, (-elo_diff/400.0)) + 1.0)
mult = math.log(max(pd, 1) + 1.0) * (2.2 / (1.0 if game['result1'] == 0.5
       else ((elo_diff if game['result1'] == 1.0 else -elo_diff) * 0.001 + 2.2)))
```

(team1 = home team; HFA added only when not neutral.) The `(elo_diff if won else
-elo_diff)` only *signs* the gap from the winner's perspective — it does not strip HFA
back out. Our implementation does exactly this. **Outcome #1: the HFA-in-MOV-denominator
structure matches 538**, so the asterisk-avoidance holds, no code change is triggered (no
re-backfill), and the `/research/elo-methodology` piece may claim a structural/formula
match.

**What is NOT claimed (numeric HFA).** The match is structural, not numeric. The HFA
*constant* differs: we use **50**, this repo uses **65**, and 538's production model used
a rolling ~55. Per ADR-0014, our 50 is an inherited, tunable v1 default — so the piece
claims a *formula/structure* match (HFA folded into the rating gap before the MOV
denominator), **not** a numeric-HFA match.

**Cite the right 538.** The "matches 538" claim is most precisely "matches 538's public
reference implementation in `nfl-elo-game/forecast.py`" — the inspectable-code version.
538's production model carried further refinements we deliberately do not adopt (rolling
HFA; the 1.2 playoff multiplier — cf. ADR-0014's no-playoff-K-bump stance). The piece
should cite the GitHub repo as the reference so a reader who knows the more elaborate
production model does not read it as overclaiming.

**Note (2026-06-18): the `/research/elo-methodology` piece was cut** (see
[ADR-0010](0010-v1-build-sequence.md)'s 2026-06-18 update; Slice-3 decision #11). The
verification recorded in this section therefore no longer feeds a publication — it
stands as part of the methodology documentation in the ADR set (ADR-0014/0021/0022),
which now serves the role the piece would have. The "matches 538" framing above is
retained as the verified factual finding, not as a claim a forthcoming piece will make;
the "cite the right 538" and tie-deviation-framing guidance is preserved for whatever
investigation, if any, ADR-0012 #2 is eventually re-pointed at.

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

## 4. Home-field derives from the modal home stadium, not `location`

Point 3 above assumed the schedule's `location` flag is authoritative. Chunk 4 prep
showed it is not for 2025: seven 2025 regular-season games are flagged
`location='Neutral'` while played at the home team's **own** stadium (KC@LAC at SoFi,
DEN@NYJ at MetLife, WAS@MIA at Hard Rock, …). Whether `location` or `stadium` is the
wrong field cannot be settled from the data, so home-field is instead **derived from
the venue**: HFA = 50 applies iff the game is at the home team's modal home stadium
(by the stable `stadium_id`), and the game is neutral (HFA = 0) otherwise. This is
correct under either reading of the anomaly, and `game.isNeutralSite` derives from
the *same* computation, so the two never disagree.

The derivation was validated against `location` across all five seasons (see
`verify_home_field.py`): it agrees **exactly** for 2021-2024 (the verified-real
international games and relocations) and disagrees **only** on the seven 2025 games —
confirming the method is sound and 2025 is the lone anomaly. Re-running the chain with
venue-derived HFA versus the `location` flag moved the 2026 Week-0 baseline by at most
**1.8 ELO with no change to ordering**, so the correction is immaterial; the robust
derivation lands because it is correct, not because the numbers demanded it.

## Cross-references

- ADR-0014 — the methodology this amends (original body preserved there).
- ADR-0021 — playoff `teamWeekStats` representation (the ELO chain's storage shape).
