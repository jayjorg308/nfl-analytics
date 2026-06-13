# EPA aggregation methodology (Phase 3a team-week stats)

This ADR records how `teamWeekStats`' seven `*EpaPerPlay` columns are computed
from nflverse play-by-play. It is the EPA analogue of ADR-0014 (ELO): the
methodology locks in durably at Phase 3a (see ADR-0008, ADR-0015), so the
definitional choices are recorded here rather than left implicit in pandas.
ADR-0002 already owns the *sign convention*; `docs/schema-design.md` owns the
*snapshot semantics*; this ADR owns the *aggregation* — which plays count, how
they are combined, and what each column means. The values feed the slate
dashboard's matchup edges and the `/research/elo-methodology` piece's worked
examples, so getting the standard definition exactly right (no asterisks) is
load-bearing for the project's reproducibility claim.

The findings below were confirmed against the 2024 season during Chunk 2.

## Play universe

EPA is aggregated over **scrimmage plays only**: `pass == 1 OR rush == 1`. This
is the nflfastR/nflverse-standard EPA/play universe — it captures every dropback
(sacks, scrambles, and throwaways all carry `pass == 1`) and every designed run,
and excludes special teams, kneels, and spikes. A defensive `epa.notna()` guard
is applied: nflverse surfaces dead-ball rows (timeouts, end-of-quarter) as NaN
EPA, not 0.0 (verified in Chunk 2 — 570 NaN rows in 2024, all `play_type` null,
distinct from genuine zero-EPA plays), and those rows are `pass == 0 & rush == 0`
anyway, so the scrimmage filter already excludes them; the guard is belt-and-suspenders.

Aggregation covers the **regular season only** (`season_type == "REG"`). The
deepest reason is **comparability**, not sample size. A season-to-date cumulative
mean computed over a mixed regular-season-plus-playoff universe is not comparable
across teams, because the playoff schedule is itself a function of team strength: a
Super Bowl team's cumulative would fold in four playoff games, a wild-card loser's
only one, and a non-playoff team's none. The slate dashboard's entire job is
cross-team comparison, so the cumulative EPA must be computed over the universe
every team shares — the 17-game regular season. (Seed scale and slate-relevance
point the same direction, but comparability is the load-bearing reason a future
reader should weigh before revisiting this.)

## Two-point conversions are excluded

Two-point conversions are excluded via `two_point_attempt != 1`. This is part of
the standard nflverse EPA/play **definition**, not a refinement to it — a reader
recomputing "standard EPA/play" who *includes* 2pt plays gets a different number
and cannot tell why. Excluding them keeps our numbers reproducible against the
convention we cite, the same discipline as matching FiveThirtyEight's ELO formula
precisely (ADR-0014).

The filter is written `two_point_attempt != 1` rather than the tempting proxy
`down.notna()`. Chunk 2 confirmed why: in 2024, all 148 two-point attempts among
scrimmage plays have a null `down`, but **7 additional scrimmage plays have a null
`down` and are not two-point attempts**. `down.notna()` would silently drop those
7 legitimate plays; `two_point_attempt != 1` targets exactly the 2pt rows. The
`!= 1` form (rather than `== 0`) also keeps any NaN-flag rows instead of dropping
them.

## Per-play means are pooled, not averaged

`offensiveEpaPerPlay` and `defensiveEpaPerPlay` are **pooled means** — `mean(epa)`
over the union of the team's pass and rush plays — and therefore play-count-weighted
toward whichever phase the team ran more. They are **not** the simple average
`(passEpa + rushEpa) / 2`. This is stated explicitly because the average-of-averages
form looks equivalent and is not: a team that passes twice as often as it runs
(typical) has an overall offensive EPA pulled toward its passing number. The Slice 1
seed encodes the pooled form (KC's seeded offensive EPA 0.10 sits between rush 0.02
and pass 0.14 at roughly a 2:1 weighting), and a future reader must not "simplify"
the pooled mean into an average.

## `overallEpaPerPlay` definition

`overallEpaPerPlay = (offensiveEpaPerPlay − defensiveEpaPerPlay) / 2` — the balanced
per-play average of offensive efficiency and defensive suppression. Three reasons:

1. **It matches the shipped scale.** The Slice 1 seed encodes exactly this formula
   (verified across winners and losers — e.g. NO `(0.34 − (−0.30))/2 = 0.32`, ATL
   `(0.02 − 0.26)/2 = −0.12`). The dashboard's visual thresholds were tuned against
   that scale; a different definition (e.g. the net sum `off + def`) would silently
   double the column's magnitude.
2. **It cannot drift.** Overall is derived from the two stored sides, so it is always
   internally consistent with its own components — there is no independent aggregation
   to fall out of sync.
3. **It is reproducible by hand.** A reader can re-derive it from the two adjacent
   columns, no archive or recomputation required.

It keeps `overall` on the same numeric scale as the offensive/defensive columns
(an efficiency, not a doubled sum), which is what the dashboard expects.

## Defensive sign convention (application of ADR-0002)

`defensiveEpaPerPlay = mean(epa where defteam == team)`, with **no sign flip**. EPA
in the parquet is already from the offense's perspective, so the mean EPA on plays
where a team is on defense *is* "what that defence allows per play" — exactly the
ADR-0002 convention (strong defence negative, weak defence positive). The offense
/ defence duality was confirmed in Chunk 2: in their week-1 game, New Orleans'
`offensiveEpaPerPlay` equalled Carolina's `defensiveEpaPerPlay` to the decimal,
because they are the same plays viewed from the two sides.

## EPA and ELO are measured over different universes

EPA here is regular-season-only; ELO (ADR-0014) incorporates the playoffs. This is
deliberate and not an inconsistency — the two columns measure different things. EPA
is a **per-play efficiency**, most comparable across teams when restricted to the
shared regular-season universe (see "Play universe" above). ELO is a **game-outcome
rating** that should reflect playoff performance: beating a strong opponent in
January is real evidence of strength, and ADR-0014's regression rule explicitly
regresses each team's *last-played-game* ELO — which for a playoff team is a playoff
game. So a single `teamWeekStats` row can legitimately summarise EPA over one game
set and ELO over another; this is recorded explicitly so it does not later read as a
bug.

Whether the playoff ELO progression is *stored* as its own `teamWeekStats` rows
(weeks 19+) or computed in-memory and folded only into the next season's Week-0
regression baseline is resolved in Chunk 3 (the ELO work) — it interacts directly
with ADR-0014's regression rule and is the first decision there.

## Season-to-date snapshot semantics

Each `(team, week)` row is **cumulative season-to-date through week N**, per the
`docs/schema-design.md` snapshot pattern ("what SEA looks like at end of week 5",
not "what happened in week 5"). For historical seasons this is the only place the
value can live — Phase 3a writes no `play` rows (ADR-0015), so the season-to-date
EPA cannot be recomputed at query time and must be materialised.

Cumulation is implemented as `cumsum(epa) / cumsum(count)` over weeks within a team.
**Bye weeks carry forward for free**: a week with no plays contributes 0 to both the
running sum and the running count, leaving the cumulative mean unchanged — which is
exactly the snapshot pattern's "state unchanged" semantics, with no special-casing.
Week-0 baseline rows carry 0 EPA (no games played yet).

## Tunability posture

Same posture as ADR-0014's ELO constants: defensible standard now, refinable with
real-data evidence. The play universe and the 2pt exclusion are the *locked standard*
— they define "standard EPA/play" and are not knobs. The genuinely tunable item is
**accepted-penalty ("no_play") handling**: those rows are currently excluded (they
are `pass == 0 & rush == 0`), which drops some DPI/holding EPA; nflverse attributes
most accepted-penalty effect onto the resulting play, so the loss is marginal, but
this is the dial to revisit if a future analysis needs penalty-inclusive EPA.
