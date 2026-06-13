# Playoff `teamWeekStats` representation (Phase 3a stores playoff-week rows)

Phase 3a stores `teamWeekStats` rows for the playoff weeks (19-22), not just the
regular season. This decision emerged in Chunk 3 (the ELO chain) and is recorded
separately from the methodology and aggregation ADRs because it is
*representation*-shaped: it concerns which rows exist and why, and it turns on a
read-side rendering coupling. It cross-references ADR-0014 (ELO methodology /
regression), ADR-0020 (EPA is regular-season-only), ADR-0009 + `schema-design.md`
(view-as-read-shape and snapshot patterns), and ADR-0015 (Phase 3a scope).

## The decision

The v1 slate dashboard is **live during playoff weekends**, so each playoff round
gets `teamWeekStats` rows. The column treatment is **three-way** — each column does
the right thing for the *kind* of quantity it is:

- **Frozen at week 18** — the seven EPA columns, the six traditional per-game
  aggregates, and `sosRank`. These are regular-season **rates / efficiencies**,
  comparable across teams only when restricted to the regular season; advancing them
  through the playoffs reintroduces the variable-playoff-game-count comparability
  problem that REG-only EPA (ADR-0020) and SOS (ADR-0023) exist to avoid.
- **Advancing as a count** — `recordWins` / `recordLosses` / `recordTies`. A win is a
  win: playoff wins are counted identically to regular-season wins, there is no rate
  or denominator and so no comparability or small-sample problem. A divisional card
  showing "13-4" for a team that won its wild-card game (and is actually 14-4) would
  be a **stale count**, not a comparable-but-different measure — it would read as a
  bug to anyone who knows the result. Record is most *accurate* when current, exactly
  where the rates are most *comparable* when frozen; each column doing the right thing
  for what it is is coherent, not inconsistent. (NFL playoff games cannot tie, so the
  playoff record cumulation only ever increments W or L.)
- **Advancing as a rating** — `eloRating` / `eloChange`. ELO is the one measure
  ADR-0014 defines as playoff-inclusive (a game-outcome rating that should reflect
  January wins).

So a conference-championship card shows a current win-count alongside frozen
efficiency rates alongside a playoff-updated rating — each correct for what it is.

## Why: the rendering coupling

The alternative — storing only weeks 0-18 — is cleaner as a table but breaks the
dashboard. `getCurrentWeek` returns the earliest week with a non-final game and has
no week-18 ceiling, so in-season it advances into the playoff weeks. The
`week_summary` view INNER JOINs `teamWeekStats ON week = g.week - 1`. A divisional
game (week 20) therefore needs week-19 rows for both teams; without them the INNER
JOIN drops the game and the dashboard renders "Week 20 slate · 0 games." Wild-card
weekend (week 19, joining week 18) would still render, but divisional and beyond
would silently vanish.

So storing playoff rows is what lets the existing view render playoff slates with
zero view changes. **`getCurrentWeek` is deliberately left uncapped** — its advance
into playoff weeks is the desired behavior under this decision, not a bug to fix.

## Intentional ragged shape

Regular-season weeks carry 32 rows; playoff weeks are ragged — only teams alive in a
round get that round's row. The per-week row counts, verified identical across
2021-2025 (and the playoff week numbering verified uniform, WC=19 … SB=22):

| week | 0-18 | 19 (WC) | 20 (DIV) | 21 (CON) | 22 (SB) |
| ---- | ---- | ------- | -------- | -------- | ------- |
| rows | 32   | **14**  | 8        | 4        | 2       |

Week 19's `14` is `12 teams that played wild-card weekend + 2 #1-seed byes`. The bye
teams get a week-19 **carry-forward** row (ELO unchanged, `eloChange = 0`) precisely
so their divisional games join at week 19 — the same carry-forward mechanism
regular-season byes already use. A wild-card loser has a week-19 row (they played
that round) but no week-20 row (eliminated). This raggedness is correct and
intentional; documenting the 14/8/4/2 shape keeps a future row-count check from
reading weeks 19+ as "missing teams."

## Regression coupling (ADR-0014): stored ELO == regression input, by construction

The ELO chain processes playoff games regardless — ADR-0014's inter-season rule
regresses each team's *last-played-game* ELO, which for a playoff team is a playoff
game. Under this decision those same intermediate values are also the stored week
19-22 rows: the chain updates ELO game-by-game and never resets, so each team's ELO
after its final game equals both its top stored playoff row (week 22/21/20/19 by how
far it advanced; week 18 for non-playoff teams) and the value regressed 1/3 toward
1500 for the next season's Week-0 baseline. There is no divergence between the
displayed playoff ELO and the regression input — they are the same number.

## EPA and ELO over different universes

This row carries EPA over one game set (regular season, ADR-0020) and ELO over
another (regular season + playoffs, ADR-0014). That is deliberate, not an
inconsistency — see ADR-0020's "EPA and ELO are measured over different universes."
The frozen-EPA / advancing-ELO playoff row is the concrete manifestation of that
split.
