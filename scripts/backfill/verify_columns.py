"""Chunk 2 reader-equivalence verification (development check).

Confirms that reading nflverse play-by-play via nfl_data_py -> fastparquet
(Python) hands back data whose semantics match what docs/parquet-mapping.md
documented from the pre-Slice-1 spike's hyparquet (Node) reads. The point is
NOT "did columns load" but "do two different parquet readers agree on the
documented semantics" — that is what de-risks building the ELO chain on
fastparquet's reads.

Highest-stakes check (CHECK 3): epa nulls. Timeouts / end-of-quarter /
dead-ball rows must surface as actual NaN, not 0.0 — otherwise per-play EPA
averages silently include zero-rows in the denominator and dilute every team's
EPA, biasing dashboard edges and the methodology story.

Run:
    uv run verify_columns.py            # default season 2024
    uv run verify_columns.py 2022
"""

from __future__ import annotations

import sys

import nfl_data_py as nfl
import pandas as pd

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2024

# Columns parquet-mapping.md documents semantics for, that Chunk 2 depends on.
BOOL_DOUBLE_FLAGS = ["pass", "rush", "success", "complete_pass", "interception"]
SCORE_STATE = [
    "home_score", "away_score",             # final, replicated on every row
    "total_home_score", "total_away_score", # in-game, fixed home/away frame
    "posteam_score", "defteam_score",       # in-game, possession-team frame
]
DIRECTIONAL = ["posteam", "defteam", "home_team", "away_team"]


def rule(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def main() -> None:
    rule(f"PULL - {SEASON} play-by-play via nfl_data_py -> fastparquet")
    # downcast=False keeps EPA at float64 and leaves 0/1 flags as DOUBLE, matching
    # what parquet-mapping.md recorded; include_participation=False stays in
    # Phase 3a's team-level scope (ADR-0015).
    df = nfl.import_pbp_data([SEASON], include_participation=False, downcast=False)
    print(f"rows={len(df):,}  cols={df.shape[1]}  pandas={pd.__version__}")

    # ---- CHECK 1: boolean-like flags stored as DOUBLE 0/1 -------------------
    rule("CHECK 1 - boolean-like flags stored as DOUBLE 0/1 (parquet-mapping.md)")
    for col in BOOL_DOUBLE_FLAGS:
        if col not in df.columns:
            print(f"  {col:16s} MISSING")
            continue
        uniques = sorted(df[col].dropna().unique().tolist())
        n_null = int(df[col].isna().sum())
        print(f"  {col:16s} dtype={str(df[col].dtype):8s} "
              f"non-null uniques={uniques}  nulls={n_null:,}")

    # ---- CHECK 2: three score-state representations ------------------------
    rule("CHECK 2 - three score-state representations (one sample game)")
    gid = df["game_id"].iloc[0]
    g = df[df["game_id"] == gid]
    print(f"  sample game_id={gid}  ({len(g)} plays)")
    for col in SCORE_STATE:
        if col not in df.columns:
            print(f"  {col:18s} MISSING")
            continue
        ndistinct = int(g[col].nunique(dropna=True))
        print(f"  {col:18s} distinct_in_game={ndistinct:3d}  "
              f"min={g[col].min()}  max={g[col].max()}")
    print("  expect: home_score/away_score distinct==1 (final, replicated);")
    print("          total_*/posteam/defteam vary in-game; their max == the final.")

    # ---- CHECK 3: epa null-handling (highest stakes) -----------------------
    rule("CHECK 3 - epa null-handling (null must be NaN, NOT 0.0)")
    epa = df["epa"]
    n = len(epa)
    n_null = int(epa.isna().sum())
    n_zero = int((epa == 0.0).sum())  # NaN == 0.0 is False, so true zeros only
    print(f"  epa dtype            = {epa.dtype}")
    print(f"  total rows           = {n:,}")
    print(f"  null (NaN) epa rows  = {n_null:,}  ({n_null / n:.1%})")
    print(f"  exactly-0.0 epa rows = {n_zero:,}")
    print(f"  -> NaN and 0.0 are DISTINCT populations: {n_null:,} NaN vs {n_zero:,} zeros")
    print("\n  play_type for null-epa rows (top 10):")
    null_pt = df.loc[epa.isna(), "play_type"].value_counts(dropna=False).head(10)
    for pt, cnt in null_pt.items():
        print(f"    {str(pt):22s} {cnt:,}")
    mean_excl = epa.mean()              # NaN-excluded (correct)
    mean_zero = epa.fillna(0.0).mean()  # nulls-as-zero (the bug this guards against)
    print(f"\n  league mean epa, nulls EXCLUDED (correct) = {mean_excl:+.5f}")
    print(f"  league mean epa, nulls as 0.0  (the bug)  = {mean_zero:+.5f}")
    print(f"  per-play dilution that would be introduced = {abs(mean_excl - mean_zero):.5f}")

    # ---- CHECK 4: directional / identity dtypes ----------------------------
    rule("CHECK 4 - directional / identity column dtypes")
    for col in DIRECTIONAL + ["season", "week", "play_type"]:
        if col in df.columns:
            print(f"  {col:12s} dtype={df[col].dtype}")

    rule("SUMMARY")
    print("  Cross-check the above against docs/parquet-mapping.md:")
    print("   1. flags are float with {0.0, 1.0} non-null values")
    print("   2. score-state shows the documented 3-representation split")
    print("   3. epa NaN != 0.0  <- the load-bearing one for the ELO chain")
    print("   4. directional columns are strings (object)")


if __name__ == "__main__":
    main()
