# Documentation map

This project uses several documents with distinct, non-overlapping roles:

- `CLAUDE.md` — agent operating instructions, working principles,
  current build state.
- `db/schema.ts` — the schema as it actually IS. Drizzle TS code is
  the canonical implementation reference.
- `docs/schema-design.md` — why the schema is shaped this way. Design
  rationale and cross-references to ADRs.
- `docs/parquet-mapping.md` — source-system specifics for nflverse
  parquet → Postgres ingestion.
- `docs/adr/*` — architectural decisions, one ADR per decision.
- `CONTEXT.md` — domain language and product framing.
- `docs/advisor-briefing-template.md` — the canonical briefing for a separate
  architecture-advisor session (refresh §§1–4/§7 per phase; §§5–6 durable).
  Currently scoped to Slice 4. Older phase briefings are under `docs/archive/`.
- `docs/runbook.md` — manual-override and recovery procedures for prod
  analytical data (corrective SQL, cascade re-runs).
- `docs/phase-3b-go-live-checklist.md` — first-live-week verification + the
  standing live-2026 watch-items for the Phase 3b forward-cron pipeline.
- `docs/slice-4-build-checklist.md` — the authoritative build task list for
  Slice 4 (player-level ingestion + opponent-defense-rank), consolidating every
  obligation from ADRs 0031/0032/0033.

When in doubt: implementation questions go to Drizzle, "why" questions
go to schema-design.md or the ADRs, source-system questions go to
parquet-mapping.md, vocabulary questions go to CONTEXT.md.

## Operational scripts

Standalone scripts under `scripts/` for one-off operations:

- `scripts/verify-schema.mjs` — confirms live DB shape (tables, enums,
  indexes). Run after migrations.
- `scripts/verify-view.mjs` — confirms the week_summary view exists
  and has expected columns. Run after view migrations.
- `scripts/verify-seed.mjs` — confirms the seed produced realistic
  dashboard data. Run after `npm run db:seed`.
- `scripts/verify-phase3a.mjs` — confirms the Phase 3a backfill
  (counts, ragged playoff shape, 2026 baseline, orphans, game-table
  type round-trip). Branch-agnostic via `DATABASE_URL` and diffable, so
  a prod run is validated by diffing its output against dev's. Run after
  `scripts/backfill/build.py`.

The Phase 3a backfill itself lives in `scripts/backfill/` (a self-contained
`uv`-managed Python project — see its README).

(More will land as the project grows.)
