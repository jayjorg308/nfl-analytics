@AGENTS.md

## Working principles

When making architectural or design decisions on this project, first check `docs/adr/` for an existing ADR that covers the question. If one exists, apply it. If none exists, surface the decision before implementing — we may need to write a new ADR.

When a new architectural decision is made during implementation, draft an ADR following the format of the existing ones in `docs/adr/` before considering the work complete.

## Project state

NFL analytics project, building toward v1 ship per ADR-0010's slice sequence (vertical slices, engine-first, research section in parallel). Slice numbering follows ADR-0010's post-grilling engine-split.

- ✅ **Slice 1** — deployed to Vercel: schema, `weekSummary` view, hand-seeded data, three-tier Clerk auth, Slate Dashboard skeleton.
- 🚧 **Slice 3 — team-level ingestion + MOV-ELO** (in progress):
  - ✅ **Phase 3a (historical backfill) — complete and live on prod.** Local Python one-shot in `scripts/backfill/` (ADR-0008) computing 2021–2025 + the 2026 Week-0 ELO baseline: MOV-ELO (ADR-0014), EPA aggregation (ADR-0020), strength-of-schedule (ADR-0023), playoff-row shape (ADR-0021), idempotent write + backup sequencing (ADR-0015, ADR-0024). Prod write succeeded ~2026-06-16 — prod matched dev line-for-line and `scripts/verify-phase3a.mjs` passed 21/0 (season 6 / game 1424 / teamWeekStats 3212). Correction + re-run procedures: `docs/runbook.md`.
  - ✂️ **The MOV-ELO methodology piece (`/research/elo-methodology`, Slice-3 decision #11) is CUT** — deliberate scope decision 2026-06-18, see ADR-0010's 2026-06-18 update. Not written, and no user-facing explainer replaces it: the ELO is user-facing infrastructure (not a portfolio piece), the audience already understands ELO, and the calculation is exhaustively documented in ADRs 0014/0021/0022, which stand as the methodology documentation. (The 538-HFA gate it had carried is independently resolved — ADR-0022 §2.) The coupled **ADR-0012 ship criterion #2** ("one substantive published investigation") is **resolved: deferred to post-v1** per ADR-0025 — v1 is the working tool for the friend group; the research/portfolio dimension is the post-v1 sandbox that grows out of it, not a ship gate. v1 now ships against criteria 1 and 3–6.
  - ⏭️ **Next (the ONLY remaining Slice-3 sub-slice): Phase 3b** — the Vercel weekly cron (parquet-in-Node per ADR-0008, cron trigger per ADR-0016) writing `game` / `drive` / `play` / `teamWeekStats` from 2026 Week 1 forward, consuming Phase 3a's 2026 Week-0 baseline. **Slice 3 completes when Phase 3b ships.**
- **Slice 4** player-level ingestion + denormalised opponent-rank fields (Player Page); **Slice 5** The Odds API (line columns on the Slate Dashboard + Game Detail); **Slices 6–9** the page slices (Game Detail, Player, Props, Team + Team Leaderboard) — per ADR-0010.

When starting a fresh session, read `CONTEXT.md` and `docs/README.md` first to load the project's domain language and documentation map.

## Agent skills

### Issue tracker

GitHub Issues on `jayjorg308/nfl-analytics`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
