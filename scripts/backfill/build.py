"""Chunk 4 - assemble Phase 3a rows and write them idempotently (ADR-0015).

Wires the pieces together into the three Phase 3a tables and writes directly to
Neon in one transaction:

  season          : rows for 2021-2026 (ON CONFLICT DO NOTHING - immutable ref).
  game            : every 2021-2025 game (REG + playoff).
  teamWeekStats   : 3,212 rows = the ELO row count (weeks 0-18 for all 32 teams +
                    ragged playoff weeks 19-22), each carrying EPA (ADR-0020),
                    ELO (ADR-0014), record, SOS (ADR-0023), and traditional
                    aggregates. Playoff-row column treatment is three-way per
                    ADR-0021: rates frozen at wk18, record advancing, ELO advancing.

Idempotency (ADR-0015): ON CONFLICT for season; transaction-wrapped scoped
truncate-and-reload for game / teamWeekStats; one transaction on one pooled
connection; ~500-row batches. `--dry-run` assembles everything and writes nothing.

Run:
    uv run build.py --dry-run    # assemble + report, no writes
    uv run build.py              # full write (Chunk 6 prod run uses prod DATABASE_URL)
"""

from __future__ import annotations

import argparse
from datetime import datetime
from zoneinfo import ZoneInfo

import nfl_data_py as nfl
import pandas as pd

from aggregate import EPA_COLUMNS, aggregate_team_week_epa
from backfill import load_database_url, make_pool
from elo import SEASONS, home_stadium_map, mark_neutral, run_chain
from sos import projected_week0_sos

BACKFILL_SEASONS = SEASONS                 # 2021-2025 written to `game`/`teamWeekStats`
ALL_SEASONS = SEASONS + [2026]             # season rows + 2026 wk0 baseline
EASTERN = ZoneInfo("America/New_York")
GAME_TYPE = {"REG": "regular", "WC": "wildcard", "DIV": "divisional",
             "CON": "conference", "SB": "super_bowl"}

RATE_COLUMNS = EPA_COLUMNS + [             # frozen at wk18 on playoff rows (ADR-0021)
    "sosRank",
    "pointsScoredPerGame", "passYardsPerGame", "rushYardsPerGame",
    "pointsAllowedPerGame", "passYardsAllowedPerGame", "rushYardsAllowedPerGame",
]
TRADITIONAL = ["pointsScoredPerGame", "passYardsPerGame", "rushYardsPerGame",
               "pointsAllowedPerGame", "passYardsAllowedPerGame", "rushYardsAllowedPerGame"]


# --------------------------------------------------------------------------
# Per-(season, team, week) cumulative computations
# --------------------------------------------------------------------------

def _cumulative(per_week: pd.DataFrame, weeks: range) -> pd.DataFrame:
    """Reindex each (season, team) to `weeks`, fill 0, cumulative-sum. Bye weeks
    carry forward for free (0 increment leaves the running total unchanged)."""
    out = []
    for (season, team), grp in per_week.groupby(level=["season", "team"]):
        g = grp.reset_index(level=["season", "team"], drop=True).reindex(weeks, fill_value=0.0)
        cum = g.cumsum()
        cum["season"], cum["team"], cum["week"] = season, team, cum.index
        out.append(cum)
    return pd.concat(out, ignore_index=True)


def compute_record(sched: pd.DataFrame) -> pd.DataFrame:
    """Cumulative W/L/T per (season, team, week), weeks 0-22 (advances through
    playoffs per ADR-0021; playoff games never tie)."""
    inc = []
    for g in sched.itertuples(index=False):
        hw = (g.home_score > g.away_score, g.away_score > g.home_score, g.home_score == g.away_score)
        inc.append((g.season, g.home_team, g.week, int(hw[0]), int(hw[1]), int(hw[2])))
        inc.append((g.season, g.away_team, g.week, int(hw[1]), int(hw[0]), int(hw[2])))
    df = (pd.DataFrame(inc, columns=["season", "team", "week", "w", "l", "t"])
          .groupby(["season", "team", "week"]).sum())
    cum = _cumulative(df, range(1, 23))
    cum = cum.rename(columns={"w": "recordWins", "l": "recordLosses", "t": "recordTies"})
    # week 0 = 0-0-0 for all teams
    wk0 = pd.DataFrame(
        [{"season": s, "team": t, "week": 0, "recordWins": 0, "recordLosses": 0, "recordTies": 0}
         for s in ALL_SEASONS for t in sorted(set(sched["home_team"]) | set(sched["away_team"]))]
    )
    keep = ["season", "team", "week", "recordWins", "recordLosses", "recordTies"]
    return pd.concat([wk0[keep], cum[keep]], ignore_index=True).astype(
        {"recordWins": int, "recordLosses": int, "recordTies": int})


def compute_traditional(sched: pd.DataFrame, pbp_by_season: dict[int, pd.DataFrame]) -> pd.DataFrame:
    """Cumulative per-game traditional aggregates, weeks 1-18. Points from the
    schedule; pass/rush yards (for and against) from pbp over ALL offensive plays
    (the box-score universe - distinct from EPA's scrimmage subset, per the
    `passing_yards`/`rushing_yards` columns which exclude 2pt conversions)."""
    reg = sched[sched["week"] <= 18]
    pts = []
    for g in reg.itertuples(index=False):
        pts.append((int(g.season), g.home_team, int(g.week), float(g.home_score), float(g.away_score)))
        pts.append((int(g.season), g.away_team, int(g.week), float(g.away_score), float(g.home_score)))
    base = pd.DataFrame(pts, columns=["season", "team", "week", "pf", "pa"])
    base["g"] = 1.0

    yard_rows = []
    for season, pbp in pbp_by_season.items():
        r = pbp[pbp["season_type"] == "REG"]
        off = r.groupby(["week", "posteam"])[["passing_yards", "rushing_yards"]].sum()
        off.columns = ["passF", "rushF"]
        off.index = off.index.set_names(["week", "team"])
        deff = r.groupby(["week", "defteam"])[["passing_yards", "rushing_yards"]].sum()
        deff.columns = ["passA", "rushA"]
        deff.index = deff.index.set_names(["week", "team"])
        j = off.join(deff, how="outer").reset_index()
        j["season"] = int(season)
        yard_rows.append(j)
    yards = pd.concat(yard_rows, ignore_index=True)

    per_week = base.merge(yards, on=["season", "team", "week"], how="left").fillna(0.0)
    per_week = per_week.set_index(["season", "team", "week"]).astype(float)
    cum = _cumulative(per_week, range(1, 19))
    games = cum["g"].where(cum["g"] > 0)
    return pd.DataFrame({
        "season": cum["season"], "team": cum["team"], "week": cum["week"],
        "pointsScoredPerGame": (cum["pf"] / games).fillna(0.0),
        "pointsAllowedPerGame": (cum["pa"] / games).fillna(0.0),
        "passYardsPerGame": (cum["passF"] / games).fillna(0.0),
        "rushYardsPerGame": (cum["rushF"] / games).fillna(0.0),
        "passYardsAllowedPerGame": (cum["passA"] / games).fillna(0.0),
        "rushYardsAllowedPerGame": (cum["rushA"] / games).fillna(0.0),
    })


def compute_realized_sos(games: pd.DataFrame) -> pd.DataFrame:
    """Realized point-in-time SOS rank (1=hardest) per (season, team, week 1-18):
    cumulative mean of opponents' pre-game ELO, ranked across 32 each week."""
    reg = games[games["week"] <= 18]
    opp = []
    for g in reg.itertuples(index=False):
        opp.append((g.season, g.home_team, g.week, g.away_pre))
        opp.append((g.season, g.away_team, g.week, g.home_pre))
    df = (pd.DataFrame(opp, columns=["season", "team", "week", "oppElo"])
          .assign(n=1.0).groupby(["season", "team", "week"]).sum())
    cum = _cumulative(df, range(1, 19))
    cum["avgOppElo"] = (cum["oppElo"] / cum["n"].where(cum["n"] > 0)).fillna(0.0)
    cum = cum.sort_values(["season", "week", "avgOppElo", "team"],
                          ascending=[True, True, False, True])
    cum["sosRank"] = cum.groupby(["season", "week"]).cumcount() + 1
    return cum[["season", "team", "week", "sosRank"]]


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------

def assemble_team_week_stats(elo_rows, epa, realized_sos, traditional, record,
                             projected_by_season) -> pd.DataFrame:
    """Merge all sources onto the ELO spine (which defines the 3,212 rows), then
    apply the week-0 (projected SOS, zero rates) and playoff (ADR-0021 three-way)
    treatments."""
    df = elo_rows.merge(epa, on=["season", "team", "week"], how="left")
    df = df.merge(realized_sos, on=["season", "team", "week"], how="left")
    df = df.merge(traditional, on=["season", "team", "week"], how="left")
    df = df.merge(record, on=["season", "team", "week"], how="left")

    # Week 0: zero rates; projected SOS.
    proj = pd.concat(
        [s.assign(season=season) for season, s in projected_by_season.items()],
        ignore_index=True)[["season", "team", "sosRank"]].rename(columns={"sosRank": "projRank"})
    df = df.merge(proj, on=["season", "team"], how="left")
    wk0 = df["week"] == 0
    df.loc[wk0, EPA_COLUMNS + TRADITIONAL] = 0.0
    df.loc[wk0, "sosRank"] = df.loc[wk0, "projRank"]
    df = df.drop(columns=["projRank", "offPlays", "defPlays"], errors="ignore")

    # Playoff rows (>=19): freeze the rate columns at each team's wk18 value.
    wk18 = (df[df["week"] == 18][["season", "team"] + RATE_COLUMNS]
            .rename(columns={c: c + "_f" for c in RATE_COLUMNS}))
    df = df.merge(wk18, on=["season", "team"], how="left")
    po = df["week"] >= 19
    for c in RATE_COLUMNS:
        df.loc[po, c] = df.loc[po, c + "_f"]
    df = df.drop(columns=[c + "_f" for c in RATE_COLUMNS])

    df["sosRank"] = df["sosRank"].astype(int)
    return df


def build_game_rows(sched: pd.DataFrame) -> pd.DataFrame:
    """Map the 2021-2025 schedule to `game` insert rows (abbr-keyed; team_id and
    season_id are resolved against the DB at write time)."""
    modal = home_stadium_map(sched)
    home_venues = set(modal.values())
    col = "stadium_id" if "stadium_id" in sched.columns else "stadium"
    rows = []
    for g in sched.itertuples(index=False):
        gt = pd.notna(g.gametime) and g.gametime or "13:00"
        dt = datetime.strptime(f"{g.gameday} {gt}", "%Y-%m-%d %H:%M").replace(tzinfo=EASTERN)
        neutral = bool(g.is_neutral)
        rows.append({
            "year": int(g.season), "week": int(g.week),
            "gameType": GAME_TYPE[g.game_type],
            "homeAbbr": g.home_team, "awayAbbr": g.away_team,
            "gameDateTime": dt, "isNeutralSite": neutral,
            "isInternational": neutral and getattr(g, col) not in home_venues,
            "homeScore": int(g.home_score), "awayScore": int(g.away_score),
            "status": "final", "nflverseGameId": g.game_id,
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Write (ADR-0015) - executed only when not dry-run
# --------------------------------------------------------------------------

DELETE_TEAM_WEEK_STATS = (
    "DELETE FROM team_week_stats WHERE season_id = ANY(%(reload)s) "
    "OR (season_id = %(s2026)s AND week = 0)")
DELETE_GAME = "DELETE FROM game WHERE season_id = ANY(%(reload)s)"

CLEANUP_2024_ONE_SHOT = """\
-- ADR-0015 pre-Phase-3a cleanup. Run ONCE, before the first run, before the
-- named Neon backup branch. Removes the Slice 1 hand-seeded 2024 data.
DELETE FROM team_week_stats WHERE season_id IN (SELECT id FROM season WHERE year = 2024);
DELETE FROM game           WHERE season_id IN (SELECT id FROM season WHERE year = 2024);
DELETE FROM season         WHERE year = 2024;"""


def main() -> None:
    parser = argparse.ArgumentParser(prog="build")
    parser.add_argument("--dry-run", action="store_true",
                        help="Assemble and report; execute no DB mutations.")
    parser.add_argument("--cleanup-2024", action="store_true",
                        help="Run the one-shot pre-3a hand-seed 2024 DELETE first (ADR-0015).")
    args = parser.parse_args()

    sched = nfl.import_schedules(BACKFILL_SEASONS)
    sched = sched[sched["home_score"].notna() & sched["away_score"].notna()].copy()
    sched = mark_neutral(sched)
    pbp_by_season = {s: nfl.import_pbp_data([s], include_participation=False, downcast=False)
                     for s in BACKFILL_SEASONS}

    elo_rows, _, games = run_chain(sched)
    epa = pd.concat([aggregate_team_week_epa(pbp_by_season[s]) for s in BACKFILL_SEASONS],
                    ignore_index=True)
    realized_sos = compute_realized_sos(games)
    traditional = compute_traditional(sched, pbp_by_season)
    record = compute_record(sched)

    # Projected week-0 SOS per season (uses each season's full scheduled slate).
    week0_elo = elo_rows[elo_rows["week"] == 0]
    sched_2026 = nfl.import_schedules([2026])
    sched_2026 = sched_2026[sched_2026["game_type"] == "REG"]
    projected = {}
    for season in ALL_SEASONS:
        reg = sched_2026 if season == 2026 else sched[(sched["season"] == season) &
                                                      (sched["game_type"] == "REG")]
        elos = week0_elo[week0_elo["season"] == season].set_index("team")["eloRating"].to_dict()
        projected[season] = projected_week0_sos(reg, elos)

    tws = assemble_team_week_stats(elo_rows, epa, realized_sos, traditional, record, projected)
    game_rows = build_game_rows(sched)

    # season rows: start/end from each season's first/last scheduled game.
    def _dates(frame):
        d = pd.to_datetime(frame["gameday"])
        return d.min().date(), d.max().date()
    srows = []
    for y in BACKFILL_SEASONS:
        sd, ed = _dates(sched[sched["season"] == y])
        srows.append({"year": y, "startDate": sd, "endDate": ed})
    sd, ed = _dates(sched_2026)
    srows.append({"year": 2026, "startDate": sd, "endDate": ed})
    season_rows = pd.DataFrame(srows)

    _report(args, sched, elo_rows, tws, game_rows)

    if not args.dry_run:
        _rule("WRITING (one transaction, ADR-0015)")
        _write(tws, game_rows, season_rows, args.cleanup_2024)
        print("  done.")


def _rule(t: str) -> None:
    print(f"\n{'=' * 74}\n{t}\n{'=' * 74}")


def _report(args, sched, elo_rows, tws, game_rows) -> None:
    mode = "DRY RUN" if args.dry_run else "LIVE"
    _rule(f"PHASE 3a BUILD ({mode}) - assembled, no writes yet" if args.dry_run
          else f"PHASE 3a BUILD ({mode})")

    _rule("(4) ROW-COUNT RECONCILIATION")
    print(f"  ELO rows           = {len(elo_rows):,}")
    print(f"  teamWeekStats rows = {len(tws):,}   match: {len(elo_rows) == len(tws)}")
    print(f"  game rows          = {len(game_rows):,}  (2021-2025 REG + playoff)")
    per = tws.groupby(["season", "week"]).size().unstack(fill_value=0)
    cols = [0, 1, 18, 19, 20, 21, 22]
    print("  teamWeekStats by season x week (0/1/18/19/20/21/22):")
    for season in ALL_SEASONS:
        if season in per.index:
            print(f"    {season}: " + " ".join(f"{w}={per.loc[season].get(w, 0)}" for w in cols))
    nulls = int(tws[[c for c in tws.columns if c not in ("season", "team", "week")]].isna().sum().sum())
    print(f"  NULLs across stat columns = {nulls}  (must be 0 - all teamWeekStats cols NOT NULL)")

    _rule("(1) SAMPLE FRAME - 2024 KC: wk0 -> wk1 SOS seam, a bye, and the playoff rows")
    kc = tws[(tws["season"] == 2024) & (tws["team"] == "KC")].sort_values("week")
    show = ["week", "eloRating", "eloChange", "sosRank", "recordWins", "recordLosses",
            "overallEpaPerPlay", "pointsScoredPerGame"]
    with pd.option_context("display.width", 200, "display.max_columns", 30):
        print(kc[show].to_string(index=False,
              formatters={"eloRating": "{:.1f}".format, "eloChange": "{:+.1f}".format,
                          "overallEpaPerPlay": "{:+.3f}".format,
                          "pointsScoredPerGame": "{:.1f}".format}))
    kc_game_weeks = set(sched[(sched["season"] == 2024) & (sched["week"] <= 18) &
                              ((sched["home_team"] == "KC") | (sched["away_team"] == "KC"))]["week"])
    byes = [w for w in range(1, 19) if w not in kc_game_weeks]
    print(f"  KC playoff weeks present: {sorted(w for w in kc['week'] if w >= 19)}  "
          f"(KC REG bye = wk{byes} -> carry-forward row: eloChange 0, record/rates flat)")
    print("  (wk0 sosRank = PROJECTED; wk1+ = REALIZED = the seam. Playoff rows: rates frozen, "
          "record+ELO advancing.)")

    fmt2 = {"eloRating": "{:.1f}".format, "eloChange": "{:+.1f}".format}
    cols2 = ["week", "eloRating", "eloChange", "recordWins", "recordLosses", "recordTies", "sosRank"]
    maxwk = tws.groupby(["season", "team"])["week"].max()

    _rule("(1b) ELIMINATION + MISSED-PLAYOFFS row shapes (2024)")
    loser = sorted(t for (s, t), m in maxwk.items() if s == 2024 and m == 19)[0]
    print(f"  WILD-CARD LOSER {loser}: wk17-19 (wk19 = WC loss advances record+ELO; no wk20+):")
    print(tws[(tws["season"] == 2024) & (tws["team"] == loser) & (tws["week"] >= 17)][cols2]
          .to_string(index=False, formatters=fmt2))
    print(f"    max week = {int(maxwk[(2024, loser)])} (expect 19 - eliminated, no wk20-22 rows)")
    miss = sorted(t for (s, t), m in maxwk.items() if s == 2024 and m == 18)[0]
    print(f"  MISSED PLAYOFFS {miss}: wk16-18 (nothing past wk18; wk18 record = final):")
    print(tws[(tws["season"] == 2024) & (tws["team"] == miss) & (tws["week"] >= 16)][cols2]
          .to_string(index=False, formatters=fmt2))
    print(f"    max week = {int(maxwk[(2024, miss)])} (expect 18 - no playoffs)")

    _rule("(1c) BUF/CIN 2022 spot-check - games played = 16, not 17 (cancelled Hamlin game)")
    for t in ("BUF", "CIN"):
        r = tws[(tws["season"] == 2022) & (tws["team"] == t) & (tws["week"] == 18)].iloc[0]
        gp = int(r["recordWins"] + r["recordLosses"] + r["recordTies"])
        print(f"  {t} 2022 wk18: record {int(r['recordWins'])}-{int(r['recordLosses'])}-"
              f"{int(r['recordTies'])} (games={gp})  pointsScored/G={r['pointsScoredPerGame']:.1f}  "
              f"-> per-game divides by {gp}, not 17")

    _rule("(2) SCOPED DELETE (ADR-0015 ownership boundary)")
    print(f"  {DELETE_TEAM_WEEK_STATS}")
    print(f"    reload = season_ids for years {BACKFILL_SEASONS}; s2026 = season_id for 2026")
    print(f"  {DELETE_GAME}")
    print("    -> matches ADR-0015: teamWeekStats season_id IN 2021-2025 OR (2026, wk0); "
          "game season_id IN 2021-2025")

    _rule("(3) PRE-3a 2024 HAND-SEED CLEANUP - distinct one-shot (ADR-0015)")
    print(CLEANUP_2024_ONE_SHOT)
    print("  NOTE: run once before the first run + before the named Neon backup branch; "
          "NOT part of the idempotent per-run reload.")

    if args.dry_run:
        _rule("DRY RUN COMPLETE - no rows written")


GAME_COLUMNS = [
    "season_id", "week", "game_type", "home_team_id", "away_team_id", "game_date_time",
    "is_neutral_site", "is_international", "home_score", "away_score", "status",
    "nflverse_game_id",
]
TWS_COLUMNS = [
    "team_id", "season_id", "week",
    "overall_epa_per_play", "offensive_epa_per_play", "defensive_epa_per_play",
    "offensive_pass_epa_per_play", "offensive_rush_epa_per_play",
    "defensive_pass_epa_per_play", "defensive_rush_epa_per_play",
    "elo_rating", "elo_change", "sos_rank",
    "record_wins", "record_losses", "record_ties",
    "points_scored_per_game", "pass_yards_per_game", "rush_yards_per_game",
    "points_allowed_per_game", "pass_yards_allowed_per_game", "rush_yards_allowed_per_game",
]


def _game_tuples(game_rows, team_id, season_id):
    """Native-Python tuples (psycopg does not adapt numpy/Timestamp types)."""
    out = []
    for r in game_rows.itertuples(index=False):
        out.append((
            season_id[int(r.year)], int(r.week), str(r.gameType),
            team_id[r.homeAbbr], team_id[r.awayAbbr],
            pd.Timestamp(r.gameDateTime).to_pydatetime(),
            bool(r.isNeutralSite), bool(r.isInternational),
            int(r.homeScore), int(r.awayScore), str(r.status), str(r.nflverseGameId),
        ))
    return out


def _tws_tuples(tws, team_id, season_id):
    out = []
    for r in tws.itertuples(index=False):
        out.append((
            team_id[r.team], season_id[int(r.season)], int(r.week),
            float(r.overallEpaPerPlay), float(r.offensiveEpaPerPlay), float(r.defensiveEpaPerPlay),
            float(r.offensivePassEpaPerPlay), float(r.offensiveRushEpaPerPlay),
            float(r.defensivePassEpaPerPlay), float(r.defensiveRushEpaPerPlay),
            float(r.eloRating), float(r.eloChange), int(r.sosRank),
            int(r.recordWins), int(r.recordLosses), int(r.recordTies),
            float(r.pointsScoredPerGame), float(r.passYardsPerGame), float(r.rushYardsPerGame),
            float(r.pointsAllowedPerGame), float(r.passYardsAllowedPerGame),
            float(r.rushYardsAllowedPerGame),
        ))
    return out


def _batch_insert(cur, table, columns, rows, chunk=500):
    """Multi-row VALUES in ~500-row chunks (ADR-0015)."""
    placeholders = "(" + ",".join(["%s"] * len(columns)) + ")"
    collist = ",".join(columns)
    for i in range(0, len(rows), chunk):
        batch = rows[i:i + chunk]
        sql = f"INSERT INTO {table} ({collist}) VALUES " + ",".join([placeholders] * len(batch))
        cur.execute(sql, [v for row in batch for v in row])


def _write(tws, game_rows, season_rows, cleanup_2024: bool) -> None:
    """One transaction on one pooled connection (ADR-0015): season ON CONFLICT
    DO NOTHING, scoped truncate-and-reload of game + teamWeekStats, batch inserts.
    Either all rows commit or none."""
    pool = make_pool(load_database_url())
    try:
        with pool.connection() as conn:
            with conn.transaction(), conn.cursor() as cur:
                if cleanup_2024:
                    # In the SAME transaction as the write: cleanup + reload are
                    # atomic, so a write failure leaves prod at its prior (Slice 1)
                    # state rather than the empty post-cleanup state. The named
                    # backup branch is taken BEFORE this runs (ADR-0024).
                    cur.execute(CLEANUP_2024_ONE_SHOT)
                    print("  ran one-shot 2024 hand-seed cleanup (ADR-0015), in-transaction")
                cur.executemany(
                    "INSERT INTO season (year, start_date, end_date) VALUES (%s, %s, %s) "
                    "ON CONFLICT (year) DO NOTHING",
                    [(int(r.year), r.startDate, r.endDate) for r in season_rows.itertuples()])
                cur.execute("SELECT id, year FROM season WHERE year = ANY(%s)",
                            ([int(y) for y in ALL_SEASONS],))
                season_id = {int(y): int(i) for i, y in cur.fetchall()}
                cur.execute("SELECT id, abbreviation FROM team")
                team_id = {a: int(i) for i, a in cur.fetchall()}
                reload_ids = [season_id[int(y)] for y in BACKFILL_SEASONS]

                cur.execute(DELETE_TEAM_WEEK_STATS, {"reload": reload_ids, "s2026": season_id[2026]})
                cur.execute(DELETE_GAME, {"reload": reload_ids})
                _batch_insert(cur, "game", GAME_COLUMNS, _game_tuples(game_rows, team_id, season_id))
                _batch_insert(cur, "team_week_stats", TWS_COLUMNS,
                              _tws_tuples(tws, team_id, season_id))
            # Post-commit verification.
            with conn.cursor() as cur:
                for tbl in ("season", "game", "team_week_stats"):
                    cur.execute(f"SELECT count(*) FROM {tbl}")
                    print(f"  {tbl}: {cur.fetchone()[0]} rows")
    finally:
        pool.close()


if __name__ == "__main__":
    main()
