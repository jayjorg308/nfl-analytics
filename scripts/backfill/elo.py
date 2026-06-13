"""Chunk 3 - ELO chain per ADR-0014, with playoff-row storage per ADR-0021.

Computes the v1 ELO chain across 2021-2025 and the terminal 2026 Week-0
baseline that Phase 3b consumes. Source = nflverse schedules (final scores,
chronological by week). Produces one `(season, team, week)` ELO row per
teamWeekStats row: weeks 0-18 for all 32 teams, plus ragged playoff weeks
19-22 (14/8/4/2 - only teams alive that round, with week-19 carrying the
two #1-seed byes forward so their divisional games render).

Methodology (ADR-0014): cold start all teams at 1500 for 2021 Week 0; iterate
2021 -> 2025 with the standard logistic + FiveThirtyEight MOV/autocorrelation
factor; K = 20 across regular season and playoffs (no bump); at each season
boundary regress every team's last-played-game ELO 1/3 of the way toward 1500.

Three ADR-0014 *application* points are resolved here and flagged inline,
pending confirmation (the tie case needs a 0014 amendment):

  [HFA-NEUTRAL] Home-field (HFA = 50) applies only when the game is at the home
      team's modal home stadium; neutral sites (Super Bowl, international,
      relocations) get HFA = 0. This is DERIVED from the venue, not read from the
      schedule's `location` flag, because `location` proved unreliable for 2025
      (7 games flagged Neutral while at the home team's own stadium). The modal
      derivation is correct under either reading of that anomaly, and `is_neutral`
      here is the SAME source game.isNeutralSite will use, so they never disagree.
      See ADR-0022 and verify_home_field.py.

  [MOV-HFA] The MOV autocorrelation term's `winner_elo_diff` uses the
      home-field-ADJUSTED game ratings (winner game-Elo minus loser game-Elo).
      ADR-0014 says "pre-game ELO gap from the winner's perspective" without
      pinning HFA; include-HFA is the chosen reading (ADR-0022). FLAG: the claim
      that this matches FiveThirtyEight must be verified against 538's published
      methodology BEFORE the methodology piece publishes - if 538 used raw
      ratings, switch or document a deliberate deviation. Small effect either way.

  [TIE] ADR-0014's tie prose was internally inconsistent: it stated the right
      OUTCOME ("collaps[es] to the standard K*(S_actual - S_expected)") but
      justified it via "ln(0+1) numerator is 0", which would zero the ENTIRE
      update instead. We implement the stated outcome: MOV multiplier = 1, the
      standard no-margin update (analytically correct - a tie nudges unequal
      teams toward each other). Corrected in ADR-0022. 0014's "nominal winner"
      convention is now vestigial: it existed only to keep the denominator
      evaluable, and the mult=1 short-circuit never evaluates it.
"""

from __future__ import annotations

import math

import nfl_data_py as nfl
import pandas as pd

BASE_ELO = 1500.0
K = 20.0
HFA = 50.0
REGRESSION_FRACTION = 1.0 / 3.0  # regress this far toward BASE at each boundary
SEASONS = [2021, 2022, 2023, 2024, 2025]
REG_WEEKS = range(1, 19)         # 1-18
PLAYOFF_WEEKS = range(19, 23)    # 19-22 (WC, DIV, CON, SB)


def expected_home(home_game_elo: float, away_game_elo: float) -> float:
    """Logistic expected score for the home team (ADR-0014). Inputs are the
    home-field-adjusted game ratings."""
    return 1.0 / (1.0 + 10 ** ((away_game_elo - home_game_elo) / 400.0))


def mov_multiplier(margin: int, winner_elo_diff: float) -> float:
    """538 margin-of-victory factor with autocorrelation correction (ADR-0014).
    `winner_elo_diff` = winner game-Elo minus loser game-Elo [MOV-HFA], negative
    on upsets; `margin` = absolute scoring margin."""
    return math.log(abs(margin) + 1.0) * 2.2 / ((winner_elo_diff * 0.001) + 2.2)


def update_game(home_elo: float, away_elo: float, home_score: int,
                away_score: int, neutral: bool) -> tuple[float, float, dict]:
    """Return (new_home_elo, new_away_elo, trace) for one game."""
    hfa = 0.0 if neutral else HFA          # [HFA-NEUTRAL]
    home_game = home_elo + hfa
    away_game = away_elo
    exp_h = expected_home(home_game, away_game)
    exp_a = 1.0 - exp_h

    if home_score > away_score:
        s_h, s_a = 1.0, 0.0
        winner_diff = home_game - away_game
        margin = home_score - away_score
        mult = mov_multiplier(margin, winner_diff)
    elif away_score > home_score:
        s_h, s_a = 0.0, 1.0
        winner_diff = away_game - home_game
        margin = away_score - home_score
        mult = mov_multiplier(margin, winner_diff)
    else:                                   # [TIE] - MOV multiplier = 1
        s_h = s_a = 0.5
        winner_diff = 0.0
        margin = 0
        mult = 1.0

    new_home = home_elo + K * mult * (s_h - exp_h)
    new_away = away_elo + K * mult * (s_a - exp_a)
    trace = {
        "hfa": hfa, "exp_home": exp_h, "margin": margin,
        "winner_diff": winner_diff, "mult": mult,
        "delta_home": new_home - home_elo, "delta_away": new_away - away_elo,
    }
    return new_home, new_away, trace


def _venue_col(sched: pd.DataFrame) -> str:
    """Prefer the stable `stadium_id` over the renameable `stadium` name."""
    return "stadium_id" if "stadium_id" in sched.columns else "stadium"


def home_stadium_map(sched: pd.DataFrame) -> dict[str, str]:
    """Each team's modal home venue across all its home games - robust to the
    handful of international / relocated 'home' games and to an unreliable
    `location` flag."""
    col = _venue_col(sched)
    return sched.groupby("home_team")[col].agg(lambda s: s.mode().iloc[0]).to_dict()


def mark_neutral(sched: pd.DataFrame) -> pd.DataFrame:
    """Add `is_neutral`: True when the venue is NOT the home team's modal home
    stadium. HFA and game.isNeutralSite both derive from this single source."""
    col = _venue_col(sched)
    modal = home_stadium_map(sched)
    s = sched.copy()
    s["is_neutral"] = s[col].ne(s["home_team"].map(modal))
    return s


def _regress(elos: dict[str, float]) -> dict[str, float]:
    """Regress each team 1/3 of the way toward 1500 (ADR-0014 inter-season)."""
    return {t: BASE_ELO + (e - BASE_ELO) * (1.0 - REGRESSION_FRACTION)
            for t, e in elos.items()}


def run_chain(sched: pd.DataFrame, trace_ids: set[str] | None = None
              ) -> tuple[pd.DataFrame, list[dict], pd.DataFrame]:
    """Iterate the full chain. Returns (elo_rows, traces, games).

    elo_rows : one row per (season, team, week) with eloRating + eloChange, for
        seasons 2021-2025 (weeks 0-18 + ragged playoff weeks) and 2026 week 0.
    games    : one row per game with both teams' pre-game ELO (home_pre/away_pre),
        used downstream for realized point-in-time SOS (ADR-0023).
    """
    trace_ids = trace_ids or set()
    teams = sorted(set(sched["home_team"]) | set(sched["away_team"]))
    elos = {t: BASE_ELO for t in teams}     # 2021 Week 0 cold start
    rows: list[dict] = []
    traces: list[dict] = []
    games: list[dict] = []

    def emit(season: int, team: str, week: int, change: float) -> None:
        rows.append({"season": season, "team": team, "week": week,
                     "eloRating": elos[team], "eloChange": change})

    def emit_week0(season: int) -> None:
        for t in teams:
            emit(season, t, 0, 0.0)

    def play(g, season: int, wk: int) -> None:
        eh, ea = elos[g.home_team], elos[g.away_team]  # pre-game ELOs
        nh, na, tr = update_game(eh, ea, int(g.home_score), int(g.away_score),
                                 g.is_neutral)
        elos[g.home_team], elos[g.away_team] = nh, na
        games.append({"season": season, "week": wk, "game_id": g.game_id,
                      "home_team": g.home_team, "away_team": g.away_team,
                      "home_pre": eh, "away_pre": ea,
                      "home_score": int(g.home_score), "away_score": int(g.away_score)})
        if g.game_id in trace_ids:
            traces.append({"game_id": g.game_id, "season": season, "week": wk,
                           "home": g.home_team, "away": g.away_team,
                           "home_score": int(g.home_score),
                           "away_score": int(g.away_score),
                           "pre_home": eh if wk == 1 else None, **tr})

    for season in SEASONS:
        s = sched[sched["season"] == season].sort_values(["week", "game_id"])
        emit_week0(season)
        prev = dict(elos)

        # Regular season: every team gets a row (played -> game delta; bye -> 0).
        for wk in REG_WEEKS:
            for g in s[s["week"] == wk].itertuples(index=False):
                play(g, season, wk)
            for t in teams:
                emit(season, t, wk, elos[t] - prev[t])
            prev = dict(elos)

        # Playoffs: ragged. Only teams that played the round get a row, except
        # week 19 also carries the two #1-seed byes forward (DIV teams absent
        # from WC), so their divisional games can join at week 19.
        post = s[s["week"].isin(PLAYOFF_WEEKS)]
        played = {wk: set(post[post["week"] == wk]["home_team"]) |
                      set(post[post["week"] == wk]["away_team"])
                  for wk in PLAYOFF_WEEKS}
        byes = played[20] - played[19]      # in divisional but not wild card
        for wk in PLAYOFF_WEEKS:
            for g in post[post["week"] == wk].itertuples(index=False):
                play(g, season, wk)
            emit_teams = set(played[wk])
            if wk == 19:
                emit_teams |= byes          # carry-forward (change == 0)
            for t in emit_teams:
                emit(season, t, wk, elos[t] - prev[t])
            prev = dict(elos)

        elos = _regress(elos)               # boundary -> next season's Week 0

    emit_week0(2026)                        # terminal baseline Phase 3b consumes
    return pd.DataFrame(rows), traces, pd.DataFrame(games)


# --------------------------------------------------------------------------
# Standalone validation (no DB writes)
# --------------------------------------------------------------------------

def _rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def main() -> None:
    sched = nfl.import_schedules(SEASONS)
    sched = sched[sched["home_score"].notna() & sched["away_score"].notna()].copy()
    sched = mark_neutral(sched)  # HFA derives from modal home stadium, not `location`

    # Pick 3 games to expose the arithmetic (ADR-0012 #4 hand-verification):
    # first 2021 game (cold start, both 1500), a mid-chain game, the 2024 SB.
    g_first = sched[sched["season"] == 2021].sort_values(["week", "game_id"]).iloc[0]
    g_sb = sched[(sched["season"] == 2024) & (sched["game_type"] == "SB")].iloc[0]
    g_mid = sched[(sched["season"] == 2023) & (sched["week"] == 10)] \
        .sort_values("game_id").iloc[0]
    trace_ids = {g_first["game_id"], g_sb["game_id"], g_mid["game_id"]}

    rows, traces, _ = run_chain(sched, trace_ids=trace_ids)
    print(f"pandas={pd.__version__}  elo rows={len(rows):,}")

    _rule("HAND-VERIFY 3 GAMES (ADR-0012 #4) - components for manual check")
    for t in sorted(traces, key=lambda d: (d["season"], d["week"])):
        neutral = "(neutral)" if t["hfa"] == 0 else f"(HFA {t['hfa']:.0f} -> home)"
        print(f"\n  {t['game_id']}  {t['away']} {t['away_score']} @ "
              f"{t['home']} {t['home_score']}  {neutral}")
        print(f"    exp_home={t['exp_home']:.4f}  margin={t['margin']}  "
              f"winner_elo_diff={t['winner_diff']:+.1f}  mov_mult={t['mult']:.4f}")
        print(f"    delta_home={t['delta_home']:+.2f}  delta_away={t['delta_away']:+.2f}")

    _rule("COLD-START -> DIFFERENTIATION (2021 ELO spread by week)")
    y21 = rows[rows["season"] == 2021]
    for wk in [1, 6, 12, 18]:
        w = y21[y21["week"] == wk]["eloRating"]
        print(f"  2021 wk{wk:<2d}  spread(max-min)={w.max() - w.min():6.1f}  "
              f"std={w.std():5.1f}")

    _rule("5-SEASON TRAJECTORY - one team's Week-0 baselines + final ELO")
    team = "KC"
    for season in SEASONS + [2026]:
        wk0 = rows[(rows["season"] == season) & (rows["team"] == team) &
                   (rows["week"] == 0)]["eloRating"]
        last = rows[(rows["season"] == season) & (rows["team"] == team)]
        last_elo = last.sort_values("week")["eloRating"].iloc[-1] if len(last) else float("nan")
        wk0v = wk0.iloc[0] if len(wk0) else float("nan")
        print(f"  {team} {season}: week0={wk0v:7.1f}   season-end={last_elo:7.1f}")

    _rule("2026 WEEK-0 BASELINE (the Phase 3b input)")
    b = rows[(rows["season"] == 2026) & (rows["week"] == 0)].set_index("team")["eloRating"]
    print(f"  teams={len(b)}  mean={b.mean():.1f}  range=[{b.min():.1f}, {b.max():.1f}]")
    print("  top 5:   " + ", ".join(f"{t} {v:.0f}" for t, v in b.sort_values(ascending=False).head(5).items()))
    print("  bottom 5:" + ", ".join(f"{t} {v:.0f}" for t, v in b.sort_values().head(5).items()))

    _rule("ROW-COUNT CHECK (intentional ragged playoff shape)")
    for season in SEASONS:
        sr = rows[rows["season"] == season]
        counts = {wk: int((sr["week"] == wk).sum()) for wk in [0, 18, 19, 20, 21, 22]}
        print(f"  {season}: wk0={counts[0]} wk18={counts[18]} | "
              f"wk19={counts[19]} wk20={counts[20]} wk21={counts[21]} wk22={counts[22]}")
    print(f"  2026: wk0={int(((rows['season'] == 2026) & (rows['week'] == 0)).sum())}")


if __name__ == "__main__":
    main()
