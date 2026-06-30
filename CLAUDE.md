@AGENTS.md

## Working principles

When making architectural or design decisions on this project, first check `docs/adr/` for an existing ADR that covers the question. If one exists, apply it. If none exists, surface the decision before implementing — we may need to write a new ADR.

When a new architectural decision is made during implementation, draft an ADR following the format of the existing ones in `docs/adr/` before considering the work complete.

## Project state

NFL analytics project, building toward v1 ship per ADR-0010's slice sequence (vertical slices, engine-first, research section in parallel). Slice numbering follows ADR-0010's post-grilling engine-split.

- ✅ **Slice 1** — deployed to Vercel: schema, `weekSummary` view, hand-seeded data, three-tier Clerk auth, Slate Dashboard skeleton.
- ✅ **Slice 3 — team-level ingestion + MOV-ELO — COMPLETE, live on prod (~2026-06-29).**
  - **Phase 3a (historical backfill)** — local Python one-shot in `scripts/backfill/` (ADR-0008): 2021–2025 + the 2026 Week-0 ELO baseline (MOV-ELO 0014, EPA 0020, SOS 0023, playoff-row shape 0021, backup sequencing 0015/0024); prod `verify-phase3a.mjs` 21/0 (season 6 / game 1424 / teamWeekStats 3212). Correction + re-run: `docs/runbook.md`.
  - **Phase 3b (forward weekly cron) — built + shipped.** Pipeline in `lib/ingestion/` (discovery, typed enqueue, `ingest_game` + completeness gate, `aggregate_week`, drain) + `app/api/cron/{ingest,drain}` + `vercel.json`; governed by ADRs 0016/0019/0026/0027/0028 plus **0029** (hyparquet reader, amends 0008) and **0030** (cron auth + wiring, amends 0016). Validated against Phase 3a's Python to machine epsilon. Migrations 0002/0003 applied to dev + prod. **Live on Vercel Pro, dormant until the 2026 season** (offseason discovery targets 2026 → 0 enqueued). First-live-week steps: `docs/phase-3b-go-live-checklist.md`.
  - ✂️ The MOV-ELO methodology piece is CUT (ADR-0010 2026-06-18 / ADR-0025); ADR-0012 ship-criterion #2 deferred post-v1. So Phase 3b shipping = Slice 3 done; v1 ships against criteria 1 and 3–6.
- ⏭️ **Next — Slice 4: player-level ingestion + denormalised opponent-rank fields (Player Page).** First consumer of Phase 3b's `teamWeekStats` output (opponent ranks denormalise against it). `play` already carries `rusher/receiver/passer` id+name (nullable TEXT, no FK) per ADR-0018 — Slice 4 adds the `player` table + FK. Storage principle set by ADR-0009/0011. Design briefing: `docs/advisor-briefing-template.md`.
- **Slice 5** The Odds API (line columns on the Slate Dashboard + Game Detail); **Slices 6–9** the page slices (Game Detail, Player, Props, Team + Team Leaderboard) — per ADR-0010.

When starting a fresh session, read `CONTEXT.md` and `docs/README.md` first to load the project's domain language and documentation map.

## Agent skills

### Issue tracker

GitHub Issues on `jayjorg308/nfl-analytics`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
