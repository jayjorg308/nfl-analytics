"""Phase 3a historical backfill — local one-shot script.

Computes the v1 ELO chain and EPA-derived team-week stats across the prior
five seasons (2021-2025) plus the 2026 Week 0 baseline, and writes `season`,
`game`, and `teamWeekStats` rows directly to Neon. Team-level only — no
`play`/`drive`/`playerGame` writes (ADR-0015). See:

  - docs/adr/0008  ingestion runtime / Python boundary (why this is local)
  - docs/adr/0014  ELO methodology (the chain this computes)
  - docs/adr/0015  Phase 3a scope, idempotency, prod-safety

Run from the author's laptop; never deployed. By default it reads
DATABASE_URL from the repo-root .env.local (the dev Neon branch). For a prod
run, point DATABASE_URL at the prod branch explicitly.

Usage:
    uv run backfill.py --dry-run     # connect + (later) pull/aggregate, no writes
    uv run backfill.py               # full run (writes — implemented in Chunks 2-4)

Chunk 1 status: scaffolding only. main() loads the env, opens a pool,
verifies connectivity, and exits. No parquet pull, no EPA aggregation, no
ELO computation, no writes yet — those land in Chunks 2-4.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from psycopg_pool import ConnectionPool

# Repo root is two levels up from scripts/backfill/backfill.py. Resolving
# against __file__ keeps env loading independent of the current directory.
REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / ".env.local"

log = logging.getLogger("backfill")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="backfill",
        description="Phase 3a historical backfill (team-level only; see ADR-0015).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Connect and compute without executing any DB mutations.",
    )
    return parser.parse_args(argv)


def load_database_url() -> str:
    """Load DATABASE_URL from the repo-root .env.local (the dev branch by default)."""
    if not ENV_PATH.exists():
        raise SystemExit(f"Expected env file not found: {ENV_PATH}")
    load_dotenv(ENV_PATH)
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set in .env.local")
    return url


def make_pool(database_url: str) -> ConnectionPool:
    """One small pool. Phase 3a draws a single connection for one transaction
    (ADR-0015), so min/max size of 1 is deliberate, not a placeholder.
    open=False + explicit open() avoids psycopg_pool's implicit-open warning.
    """
    pool = ConnectionPool(conninfo=database_url, min_size=1, max_size=1, open=False)
    pool.open()
    return pool


def check_connection(pool: ConnectionPool) -> None:
    """Prove connectivity to the target Neon branch. Read-only; not a mutation."""
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT current_database(), current_user, version()")
        database, user, version = cur.fetchone()
    log.info("Connected to %s as %s", database, user)
    log.info("Server: %s", version.split(",", 1)[0])


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )
    args = parse_args(argv)
    mode = "DRY RUN" if args.dry_run else "LIVE"
    log.info("Phase 3a backfill starting (%s).", mode)

    database_url = load_database_url()
    pool = make_pool(database_url)
    try:
        check_connection(pool)
    finally:
        pool.close()

    if args.dry_run:
        log.info("Dry run: no parquet pull / aggregation / writes yet (Chunk 1 scaffolding).")
    else:
        # Chunks 2-4 land here: parquet pull -> in-memory pandas EPA
        # aggregation -> ELO chain -> transaction-wrapped truncate-and-reload.
        log.info("Live run not implemented yet (Chunks 2-4). Exiting without writes.")

    log.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
