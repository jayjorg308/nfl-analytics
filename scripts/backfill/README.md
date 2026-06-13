# scripts/backfill — Phase 3a historical backfill

Local, one-shot Python script that computes the v1 ELO chain and EPA-derived
team-week stats across the prior five seasons and writes `season`, `game`, and
`teamWeekStats` rows directly to Neon. Run from the author's laptop; never
deployed (ADR-0008). Team-level only — no `play`/`drive`/`playerGame` writes
(ADR-0015).

Self-contained `uv`-managed Python project, parallel to the Node scripts in
`scripts/`. Python is pinned to 3.12 (`.python-version`); `uv.lock` pins exact
dependency versions for reproducibility-from-scratch.

## Setup

Requires [`uv`](https://docs.astral.sh/uv/). From this directory:

```sh
uv sync          # create .venv, install pinned deps
```

## Run

Reads `DATABASE_URL` from the repo-root `.env.local`, which points at the dev
Neon branch by default. For a prod run, point `DATABASE_URL` at prod explicitly.

```sh
uv run backfill.py --dry-run     # connect + (later) pull/aggregate, no writes
uv run backfill.py               # full run (writes)
```

Development / verification scripts (no DB writes):

```sh
uv run verify_columns.py [year]  # reader-equivalence: fastparquet vs the spike's
                                 # documented column semantics (parquet-mapping.md)
uv run aggregate.py [year]       # EPA aggregation sanity check (ADR-0020)
```

## Status

- **Chunk 1 (scaffolding)** — done. `backfill.py` loads env, opens a pooled Neon
  connection, verifies connectivity, exits.
- **Chunk 2 (parquet pull + EPA aggregation)** — done. `aggregate.py` computes
  season-to-date team-week EPA per ADR-0020. `verify_columns.py` is a re-runnable
  dev check confirming fastparquet (Python) agrees with the spike's
  hyparquet-documented column semantics — the reader-equivalence that justifies
  building on fastparquet, and worth re-running against future `nfl_data_py` versions.
- **Chunks 3-4 (ELO chain, DB write + idempotency)** — pending.

## References

- `docs/adr/0008` — ingestion runtime and Python boundary
- `docs/adr/0014` — v1 ELO methodology (consolidated)
- `docs/adr/0015` — Phase 3a scope, idempotency, prod-safety
- `docs/adr/0020` — EPA aggregation methodology (this chunk's decisions)
