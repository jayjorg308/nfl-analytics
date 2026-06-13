"""Chunk 2 - in-memory pandas EPA aggregation (no play/drive persistence).

Produces season-to-date team-week EPA, the seven `teamWeekStats.*EpaPerPlay`
columns, for one season at a time. The methodology is recorded in ADR-0020;
the load-bearing points, restated where the code applies them:

  - Play universe (ADR-0020): scrimmage plays only (`pass==1 | rush==1`),
    with an `epa.notna()` guard, two-point conversions excluded
    (`two_point_attempt != 1`, the standard nflverse EPA/play definition), and
    regular season only (`season_type == "REG"`).
  - Pooled means, NOT average-of-averages (ADR-0020): offensive / defensive
    "overall" is mean(epa) over the union of pass+rush plays, i.e.
    play-count-weighted toward whichever phase the team ran more. It is NOT
    (passEpa + rushEpa) / 2.
  - Defensive sign (ADR-0002, applied per ADR-0020): defensiveEpaPerPlay =
    mean(epa where defteam == team). No sign flip - epa is already
    offense-perspective, so "what they allow" falls out directly. Strong
    defense => negative.
  - overallEpaPerPlay (ADR-0020): (offensiveEpaPerPlay - defensiveEpaPerPlay)/2,
    derived from the two sides so it can never drift from its components, and
    matching the scale the Slice 1 seed encoded.
  - Season-to-date snapshot (schema-design.md snapshot pattern): each (team,
    week) row is cumulative through week N. Bye weeks carry forward for free -
    a week with no plays adds 0 to both the running sum and count, so the
    cumulative mean is unchanged.

Pandas 3.0 copy-on-write is the default here; this module never does chained
masked assignment - every transform produces a new frame.

Run (standalone sanity check, no DB writes):
    uv run aggregate.py            # season 2024
    uv run aggregate.py 2022
"""

from __future__ import annotations

import sys

import nfl_data_py as nfl
import pandas as pd

EPA_COLUMNS = [
    "overallEpaPerPlay",
    "offensiveEpaPerPlay",
    "defensiveEpaPerPlay",
    "offensivePassEpaPerPlay",
    "offensiveRushEpaPerPlay",
    "defensivePassEpaPerPlay",
    "defensiveRushEpaPerPlay",
]


def pull_season(year: int) -> pd.DataFrame:
    """Pull one season of play-by-play. downcast=False keeps epa at float64
    (precision for the cumulative means feeding the ELO chain) and leaves the
    0/1 flags as DOUBLE; participation is player-level, outside Phase 3a scope.
    """
    return nfl.import_pbp_data([year], include_participation=False, downcast=False)


def _qualifying_plays(pbp: pd.DataFrame) -> pd.DataFrame:
    """The ADR-0020 play universe. `two_point_attempt != 1` keeps NaN flags
    (excludes only explicit 2pt); `epa.notna()` guards the cumulative means."""
    mask = (
        ((pbp["pass"] == 1) | (pbp["rush"] == 1))
        & pbp["epa"].notna()
        & (pbp["two_point_attempt"] != 1)
        & (pbp["season_type"] == "REG")
    )
    return pbp.loc[mask].copy()


def _cumulative_side(qual: pd.DataFrame, role: str, grid: pd.MultiIndex) -> pd.DataFrame:
    """Per-(team, week) cumulative epa sums and counts for one role
    (`posteam` = offense, `defteam` = defense), split all/pass/rush."""
    sub = qual[[role, "week", "epa", "pass", "rush"]].rename(columns={role: "team"})
    weekly = sub.groupby(["team", "week"]).agg(s_all=("epa", "sum"), n_all=("epa", "count"))
    wk_pass = sub[sub["pass"] == 1].groupby(["team", "week"]).agg(
        s_pass=("epa", "sum"), n_pass=("epa", "count")
    )
    wk_rush = sub[sub["rush"] == 1].groupby(["team", "week"]).agg(
        s_rush=("epa", "sum"), n_rush=("epa", "count")
    )
    # pass/rush keys are a subset of all-keys -> left join, fill the gaps, then
    # reindex to the full team x week grid so bye weeks become explicit 0-rows.
    weekly = weekly.join([wk_pass, wk_rush], how="left").fillna(0.0)
    weekly = weekly.reindex(grid, fill_value=0.0)
    return weekly.groupby(level="team").cumsum()


def _per_play(s: pd.Series, n: pd.Series) -> pd.Series:
    """Cumulative mean = cumsum(epa) / cumsum(count). Zero count (a team with
    no plays of that kind yet) -> 0.0, since teamWeekStats is NOT NULL."""
    return (s / n.where(n > 0)).fillna(0.0)


def aggregate_team_week_epa(pbp: pd.DataFrame) -> pd.DataFrame:
    """Season-to-date team-week EPA for one season. Returns one row per
    (team, week) for weeks 1..max, including bye-week carry-forward rows."""
    season = int(pbp["season"].iloc[0])
    qual = _qualifying_plays(pbp)
    max_week = int(qual["week"].max())
    teams = sorted(set(qual["posteam"].dropna()) | set(qual["defteam"].dropna()))
    grid = pd.MultiIndex.from_product([teams, range(1, max_week + 1)], names=["team", "week"])

    off = _cumulative_side(qual, "posteam", grid)
    deff = _cumulative_side(qual, "defteam", grid)

    out = pd.DataFrame(index=grid)
    out["offensiveEpaPerPlay"] = _per_play(off["s_all"], off["n_all"])
    out["offensivePassEpaPerPlay"] = _per_play(off["s_pass"], off["n_pass"])
    out["offensiveRushEpaPerPlay"] = _per_play(off["s_rush"], off["n_rush"])
    out["defensiveEpaPerPlay"] = _per_play(deff["s_all"], deff["n_all"])
    out["defensivePassEpaPerPlay"] = _per_play(deff["s_pass"], deff["n_pass"])
    out["defensiveRushEpaPerPlay"] = _per_play(deff["s_rush"], deff["n_rush"])
    out["overallEpaPerPlay"] = (out["offensiveEpaPerPlay"] - out["defensiveEpaPerPlay"]) / 2.0
    out["offPlays"] = off["n_all"].astype(int)
    out["defPlays"] = deff["n_all"].astype(int)

    out = out.reset_index()
    out.insert(0, "season", season)
    return out


# --------------------------------------------------------------------------
# Standalone sanity check (no DB writes)
# --------------------------------------------------------------------------

def _rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def _diagnostic_2pt(pbp: pd.DataFrame) -> None:
    """Confirm (rather than assume) the 2pt / null-down relationship that
    motivates the `two_point_attempt != 1` filter choice."""
    _rule("DIAGNOSTIC - season_type + the 2pt / null-down relationship")
    print("  season_type value_counts:")
    for k, v in pbp["season_type"].value_counts(dropna=False).items():
        print(f"    {str(k):6s} {v:,}")
    scrim = pbp[(pbp["pass"] == 1) | (pbp["rush"] == 1)]
    is_2pt = scrim["two_point_attempt"] == 1
    down_null = scrim["down"].isna()
    print(f"\n  scrimmage (pass|rush) plays            = {len(scrim):,}")
    print(f"  ... two_point_attempt == 1             = {int(is_2pt.sum()):,}")
    print(f"  ... down is null                       = {int(down_null.sum()):,}")
    print(f"  ... 2pt AND down-null                  = {int((is_2pt & down_null).sum()):,}")
    print(f"  ... 2pt but down NOT null              = {int((is_2pt & ~down_null).sum()):,}")
    print(f"  ... down-null but NOT 2pt              = {int((~is_2pt & down_null).sum()):,}")
    print("  -> if 'down-null but not 2pt' > 0, down.notna() would over-exclude;")
    print("     two_point_attempt != 1 targets exactly the 2pt rows.")


def main() -> None:
    season = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    _rule(f"PULL - {season} play-by-play")
    pbp = pull_season(season)
    print(f"rows={len(pbp):,}  cols={pbp.shape[1]}  pandas={pd.__version__}")

    _diagnostic_2pt(pbp)

    tws = aggregate_team_week_epa(pbp)
    qual_n = len(_qualifying_plays(pbp))
    max_week = int(tws["week"].max())
    _rule("AGGREGATION SHAPE")
    print(f"  qualifying plays (ADR-0020 universe) = {qual_n:,}")
    print(f"  team-week rows                       = {len(tws):,}  "
          f"({tws['team'].nunique()} teams x weeks 1-{max_week})")

    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 20)
    fmt = {c: "{:+.3f}".format for c in EPA_COLUMNS}

    _rule("WEEK 1 (cumulative-at-wk-1 == single week) - sample teams")
    wk1 = tws[tws["week"] == 1].set_index("team")
    sample = [t for t in ["KC", "PHI", "BUF", "NO", "CAR", "NYG"] if t in wk1.index]
    print(wk1.loc[sample, EPA_COLUMNS + ["offPlays", "defPlays"]].to_string(formatters=fmt))

    _rule(f"FULL SEASON (week {max_week} cumulative) - best/worst offenses")
    full = tws[tws["week"] == max_week].set_index("team")
    ranked = full.sort_values("offensiveEpaPerPlay", ascending=False)
    show = pd.concat([ranked.head(5), ranked.tail(5)])
    print(show[EPA_COLUMNS + ["offPlays", "defPlays"]].to_string(formatters=fmt))
    print("\n  best defenses (most-negative defensiveEpaPerPlay = fewest pts allowed):")
    best_def = full.sort_values("defensiveEpaPerPlay").head(5)
    print(best_def[["offensiveEpaPerPlay", "defensiveEpaPerPlay", "overallEpaPerPlay"]]
          .to_string(formatters=fmt))

    _rule("STRUCTURAL CHECKS")
    dev = (tws["overallEpaPerPlay"]
           - (tws["offensiveEpaPerPlay"] - tws["defensiveEpaPerPlay"]) / 2.0).abs().max()
    print(f"  max |overall - (off-def)/2|          = {dev:.2e}   (must be ~0)")
    print(f"  overallEpaPerPlay range (all rows)   = "
          f"[{tws['overallEpaPerPlay'].min():+.3f}, {tws['overallEpaPerPlay'].max():+.3f}]")
    print(f"  full-season overall range            = "
          f"[{full['overallEpaPerPlay'].min():+.3f}, {full['overallEpaPerPlay'].max():+.3f}]")
    print(f"  seed week-1 overall range (reference) = [-0.320, +0.320]")
    print(f"  full-season defensiveEpaPerPlay range = "
          f"[{full['defensiveEpaPerPlay'].min():+.3f}, {full['defensiveEpaPerPlay'].max():+.3f}]")
    print("  -> good defenses negative, bad positive: convention matches ADR-0002.")


if __name__ == "__main__":
    main()
