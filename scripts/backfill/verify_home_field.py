"""Verify home-field derivation (modal home stadium) and size the Chunk 3
HFA correction. Chunk 4 prerequisite / Chunk 3 follow-up.

The schedule `location` flag proved unreliable for 2025 (games flagged Neutral
while played at the home team's own stadium). HFA and game.isNeutralSite must
instead derive from the venue: a game is neutral iff it is NOT at the home team's
modal home stadium - correct whether 2025's `location` or `stadium` field is the
wrong one.

This script (1) cross-checks the derived neutral flag against `location` across
all five seasons - they should agree for 2021-2024 (verified-real international /
relocations) and disagree only for 2025 - and (2) re-runs the ELO chain both ways
and diffs the 2026 Week-0 baseline to size the correction.

Run: uv run verify_home_field.py
"""

from __future__ import annotations

import nfl_data_py as nfl
import pandas as pd

from elo import SEASONS, _venue_col, home_stadium_map, mark_neutral, run_chain


def _rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def _baseline(rows: pd.DataFrame) -> pd.Series:
    return rows[(rows["season"] == 2026) & (rows["week"] == 0)].set_index("team")["eloRating"]


def main() -> None:
    sched = nfl.import_schedules(SEASONS)
    sched = sched[sched["home_score"].notna() & sched["away_score"].notna()].copy()
    col = _venue_col(sched)
    print(f"venue key = {col}   completed games = {len(sched):,}")

    modal = home_stadium_map(sched)
    sched["flag_neutral"] = sched["location"] != "Home"
    sched = mark_neutral(sched)  # adds is_neutral (derived)

    _rule("AGREEMENT - derived (modal stadium) vs `location` flag, by season")
    for season in SEASONS:
        s = sched[sched["season"] == season]
        disagree = s[s["is_neutral"] != s["flag_neutral"]]
        print(f"  {season}: games={len(s):3d}  derived_neutral={int(s['is_neutral'].sum()):2d}  "
              f"flag_neutral={int(s['flag_neutral'].sum()):2d}  disagreements={len(disagree)}")

    _rule("ALL DISAGREEMENTS (expect: only 2025)")
    dis = sched[sched["is_neutral"] != sched["flag_neutral"]]
    cols = [c for c in ["season", "week", "away_team", "home_team", "stadium", "location"] if c in sched.columns]
    show = dis[cols].assign(derived_neutral=dis["is_neutral"], flag_neutral=dis["flag_neutral"])
    print(show.to_string(index=False) if len(dis) else "  (none)")

    _rule("BASELINE DIFF - 2026 Week-0 ELO, stadium-derived HFA vs location-flag HFA")
    loc = sched.copy(); loc["is_neutral"] = loc["flag_neutral"]
    der = sched.copy()  # already has derived is_neutral
    b_loc = _baseline(run_chain(loc)[0])
    b_der = _baseline(run_chain(der)[0])
    diff = (b_der - b_loc).reindex(b_loc.index)
    print(f"  max |delta| = {diff.abs().max():.2f}   mean |delta| = {diff.abs().mean():.2f}   "
          f"teams moved = {int((diff.abs() > 0.05).sum())}/32")
    movers = diff.reindex(diff.abs().sort_values(ascending=False).index).head(8)
    print("  largest movers (derived - location):")
    for t, d in movers.items():
        print(f"    {t}: {b_loc[t]:7.1f} -> {b_der[t]:7.1f}  ({d:+.2f})")
    print("\n  2026 top-5 under each (does ordering change?):")
    print("    location-HFA:", ", ".join(f"{t} {v:.0f}" for t, v in b_loc.sort_values(ascending=False).head(5).items()))
    print("    derived-HFA :", ", ".join(f"{t} {v:.0f}" for t, v in b_der.sort_values(ascending=False).head(5).items()))


if __name__ == "__main__":
    main()
