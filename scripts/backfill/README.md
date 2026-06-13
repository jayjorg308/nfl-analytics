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

## Status

Chunk 1 (scaffolding) is complete: the skeleton loads env, opens a pooled
connection to Neon, verifies connectivity, and exits. Parquet pull, EPA
aggregation, the ELO chain, and DB writes land in Chunks 2-4.

## References

- `docs/adr/0008` — ingestion runtime and Python boundary
- `docs/adr/0014` — v1 ELO methodology (consolidated)
- `docs/adr/0015` — Phase 3a scope, idempotency, prod-safety
