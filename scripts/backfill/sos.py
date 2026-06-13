"""Strength-of-schedule per ADR-0023.

Week-0 `sosRank` is a DISTINCT projected metric that shares the column (ADR-0023):
no games are played, so it ranks teams by the average week-0 baseline ELO of their
*scheduled* regular-season opponents. Week-1+ `sosRank` is the realized point-in-time
metric (opponents actually played, at their pre-game ELO) - built in the Chunk 4
assembly. The two meet at the wk0->wk1 boundary; they are not the same computation.
"""

from __future__ import annotations

import pandas as pd


def projected_week0_sos(reg_schedule: pd.DataFrame, week0_elos: dict[str, float]) -> pd.DataFrame:
    """Projected week-0 SOS for one season.

    reg_schedule : that season's REGULAR-season games (home_team / away_team).
    week0_elos   : team -> week-0 baseline ELO (the regressed value the chain
                   produces; the only ELO that exists at week 0).

    Each opponent enters at its week-0 baseline; a team's own rating never enters
    (a team is never its own opponent). Division rivals appear twice (played twice),
    which is correct - you face them twice. Returns one row per team with the mean
    opponent baseline ELO, the opponent count, and `sosRank` (1 = hardest).
    """
    opp: dict[str, list[float]] = {}
    for g in reg_schedule.itertuples(index=False):
        opp.setdefault(g.home_team, []).append(week0_elos[g.away_team])
        opp.setdefault(g.away_team, []).append(week0_elos[g.home_team])

    df = pd.DataFrame(
        [{"team": t, "avgOppElo": sum(v) / len(v), "nOpponents": len(v)}
         for t, v in opp.items()]
    )
    # 1 = hardest (highest average opponent ELO); deterministic tie-break on team.
    df = df.sort_values(["avgOppElo", "team"], ascending=[False, True]).reset_index(drop=True)
    df["sosRank"] = df.index + 1
    return df
