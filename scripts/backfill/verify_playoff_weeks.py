"""Cross-season verification of playoff week numbering (Chunk 3 prerequisite).

The playoff week->integer encoding shifted historically around the 2021
17-game / 18-week change. The ELO chain orders games by week and stores
teamWeekStats rows at those week integers, so we verify the 2021-2025 actual
encodings rather than assuming 2024's WC=19..SB=22 holds for every season
(same cross-season discipline as Chunk 2's 2pt / null-down check).

Also reconciles the intentional ragged playoff row shape: regular-season weeks
carry 32 team rows; playoff weeks carry fewer, and week 19 includes the
#1-seed byes as carry-forward rows (needed so their divisional games render
through the week_summary `week = g.week - 1` join). Documenting the expected
14 / 8 / 4 / 2 shape keeps a future row-count check from reading weeks 19+ as
"missing teams."

Run: uv run verify_playoff_weeks.py
"""

from __future__ import annotations

import nfl_data_py as nfl
import pandas as pd

SEASONS = [2021, 2022, 2023, 2024, 2025]
ROUND_ORDER = ["WC", "DIV", "CON", "SB"]


def _teams(frame: pd.DataFrame) -> set[str]:
    if frame.empty:
        return set()
    return set(pd.unique(frame[["home_team", "away_team"]].values.ravel()))


def main() -> None:
    sch = nfl.import_schedules(SEASONS)
    sch = sch[sch["home_score"].notna() & sch["away_score"].notna()].copy()
    print(f"pandas={pd.__version__}  completed schedule rows={len(sch):,}\n")

    for season in SEASONS:
        s = sch[sch["season"] == season]
        post = s[s["game_type"] != "REG"]
        reg_max = int(s[s["game_type"] == "REG"]["week"].max())
        print(f"=== {season}   (REG max week = {reg_max}) ===")

        played: dict[str, set[str]] = {}
        for rnd in ROUND_ORDER:
            r = post[post["game_type"] == rnd]
            played[rnd] = _teams(r)
            weeks = sorted(r["week"].unique().tolist()) if not r.empty else []
            print(f"  {rnd:4s} : week(s)={weeks}  games={len(r)}  teams_played={len(played[rnd])}")

        playoff_teams = set().union(*played.values()) if not post.empty else set()
        wc_byes = played["DIV"] - played["WC"]  # in divisional but not wild card => bye
        wk19_rows = len(played["WC"]) + len(wc_byes)
        print(f"  playoff teams = {len(playoff_teams)}   WC byes = {len(wc_byes)} {sorted(wc_byes)}")
        print(f"  => playoff teamWeekStats ROW counts: "
              f"wk19={wk19_rows} ({len(played['WC'])} played + {len(wc_byes)} bye), "
              f"wk20={len(played['DIV'])}, wk21={len(played['CON'])}, wk22={len(played['SB'])}\n")


if __name__ == "__main__":
    main()
