"""ADR-0012 #4 hand-verification support.

Dumps, for the five chosen games, the INPUTS (pre-game ELOs from the chain,
final scores from the schedule, neutral flag) and elo.py's OUTPUT (the per-game
deltas + the exp_home / mov_mult it computed). The independently formula-derived
expected values live in the review package, NOT here — this script only supplies
the inputs to feed the hand calc and the code output to compare it against.

The five games cover every ADR-0014 ruling: cold-start (both 1500, HFA), a
mid-chain regular game, the neutral Super Bowl (HFA=0), a tie (mult=1 per
ADR-0022), and a non-neutral playoff game (HFA=50 + K=20, no playoff bump).

Run: uv run handverify.py
"""

from __future__ import annotations

import nfl_data_py as nfl

from elo import BASE_ELO, HFA, K, REGRESSION_FRACTION, SEASONS, mark_neutral, run_chain, update_game

GAMES = {
    "cold-start (both 1500, HFA=50)": "2021_01_ARI_TEN",
    "mid-chain regular":             "2023_10_ATL_ARI",
    "neutral Super Bowl (HFA=0)":    "2024_22_KC_PHI",
    "tie (mult=1, ADR-0022)":        "2025_04_GB_DAL",
    "non-neutral playoff (HFA=50, K=20)": "2021_19_ARI_LA",
}


def main() -> None:
    sched = nfl.import_schedules(SEASONS)
    sched = sched[sched["home_score"].notna() & sched["away_score"].notna()].copy()
    sched = mark_neutral(sched)
    _, _, games = run_chain(sched)
    g = games.set_index("game_id")
    neutral = sched.set_index("game_id")["is_neutral"].to_dict()

    print(f"constants: K={K}  HFA={HFA}  base={BASE_ELO}  regression={REGRESSION_FRACTION:.4f}\n")
    for label, gid in GAMES.items():
        r = g.loc[gid]
        is_neut = bool(neutral[gid])
        nh, na, tr = update_game(float(r.home_pre), float(r.away_pre),
                                 int(r.home_score), int(r.away_score), is_neut)
        print(f"{label}  [{gid}]")
        print(f"  INPUTS  pre_home={float(r.home_pre):.4f}  pre_away={float(r.away_pre):.4f}  "
              f"neutral={is_neut}  score: away {int(r.away_score)} - home {int(r.home_score)}")
        print(f"  elo.py  exp_home={tr['exp_home']:.6f}  mov_mult={tr['mult']:.6f}  "
              f"delta_home={tr['delta_home']:+.4f}  delta_away={tr['delta_away']:+.4f}")
        print(f"          post_home={nh:.4f}  post_away={na:.4f}\n")


if __name__ == "__main__":
    main()
