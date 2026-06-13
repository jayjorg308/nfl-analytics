"""Verify the projected week-0 SOS mechanics (ADR-0023 week-0 section).

The 2026 week-0 row is load-bearing: it is the only 2026 teamWeekStats row until
Phase 3b ingests week 1, so its sosRank is the strength-of-schedule value a user
sees at season start, before any 2026 game. This script confirms the three
mechanics (full 17-game slate per team, self-exclusion, baseline-ELO input) and
sanity-checks that the projection is not sign-flipped (rank 1 = hardest = highest
average opponent ELO), on the load-bearing 2026 row and the 2024 row (whose
baseline reflects 2023 strength, so it is eyeball-checkable).

Run: uv run verify_sos_week0.py
"""

from __future__ import annotations

import nfl_data_py as nfl
import pandas as pd

from elo import SEASONS, mark_neutral, run_chain
from sos import projected_week0_sos


def _rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def main() -> None:
    sched = nfl.import_schedules(SEASONS)
    sched = sched[sched["home_score"].notna() & sched["away_score"].notna()].copy()
    sched = mark_neutral(sched)
    rows, _ = run_chain(sched)
    week0 = rows[rows["week"] == 0]  # seasons 2021-2026

    for season in (2024, 2026):
        reg = nfl.import_schedules([season])
        reg = reg[reg["game_type"] == "REG"]
        elos = week0[week0["season"] == season].set_index("team")["eloRating"].to_dict()

        _rule(f"{season} projected week-0 SOS")
        self_ref = int((reg["home_team"] == reg["away_team"]).sum())
        print(f"  REG games={len(reg)}  self-ref games (home==away)={self_ref}  "
              f"baseline teams={len(elos)}")

        s = projected_week0_sos(reg, elos)
        print(f"  opponents per team: min={s['nOpponents'].min()} max={s['nOpponents'].max()} "
              f"(expect 17/17)   teams ranked={len(s)}")
        print(f"  avgOppElo range: [{s['avgOppElo'].min():.1f}, {s['avgOppElo'].max():.1f}]  "
              f"league mean={s['avgOppElo'].mean():.1f}")

        top = s.head(5)
        bot = s.tail(5)
        print("  HARDEST (rank 1-5):  " +
              ", ".join(f"{r.team}#{r.sosRank}({r.avgOppElo:.0f})" for r in top.itertuples()))
        print("  EASIEST (rank 28-32):" +
              ", ".join(f"{r.team}#{r.sosRank}({r.avgOppElo:.0f})" for r in bot.itertuples()))
        # sign check: rank 1 must have the MAX avgOppElo, rank 32 the MIN
        ok = (s.iloc[0]["avgOppElo"] == s["avgOppElo"].max()
              and s.iloc[-1]["avgOppElo"] == s["avgOppElo"].min())
        print(f"  SIGN CHECK: rank 1 has max avgOppElo and rank 32 has min -> {'PASS' if ok else 'FAIL (inverted!)'}")


if __name__ == "__main__":
    main()
