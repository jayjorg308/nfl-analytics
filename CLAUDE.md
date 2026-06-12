@AGENTS.md

## Working principles

When making architectural or design decisions on this project, first check `docs/adr/` for an existing ADR that covers the question. If one exists, apply it. If none exists, surface the decision before implementing — we may need to write a new ADR.

When a new architectural decision is made during implementation, draft an ADR following the format of the existing ones in `docs/adr/` before considering the work complete.

## Project state

NFL analytics project, building toward v1 ship per ADR-0010's slice sequence:

- ✅ Slice 1 complete and deployed to Vercel (schema, weekSummary view, hand-seeded data, three-tier Clerk auth, Slate Dashboard skeleton)
- 🚧 Slice 3 next: real ingestion (parquet-in-Node weekly + Python historical backfill for ELO grounding per ADR-0004 and ADR-0008)
- Slices 4-7 follow per ADR-0010 (Odds API, Game Detail, Player, Props, Team, Team Leaderboard pages)

When starting a fresh session, read `CONTEXT.md` and `docs/README.md` first to load the project's domain language and documentation map.

## Agent skills

### Issue tracker

GitHub Issues on `jayjorg308/nfl-analytics`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
