# NFL Analytics

[![Vercel Deploy](https://vercelbadge.vercel.app/api/jayjorg308/nfl-analytics)](https://vercel.com/jayson-nfl-analytics)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Neon-Postgres-336791?logo=postgresql&logoColor=white)](https://neon.tech/)

A personal NFL analytics platform that powers a weekly research workflow shared
with a small group of friends and doubles as a portfolio piece for my data
work. It produces prop and game-line betting context, game-watching narratives,
and ad-hoc investigations into NFL questions I'm genuinely curious about, all
backed by a real, reproducible data set rather than a pile of spreadsheet tabs.

---

## What it is

The database is a **read-side analytical store**: facts about the world plus
derivations from them. It is explicitly _not_ a system of record for
user-generated artifacts: picks, notes, and predictions live in my friends' own
sportsbooks and spreadsheets. The platform reads, computes, and presents; it
doesn't track what anyone wagered.

The product splits into two surfaces:

- **The gated research workflow**, the operational tool. A weekly drill-down
  from the **Slate Dashboard** (the marquee view, entry point of every session)
  into game, player, and prop detail, surfacing EPA matchup edges, splits
  (Season / L3 / L5 / Home / Away), hit rates against closing lines, and
  strength-of-schedule context.
- **The public research section** (`/research/*`), the portfolio surface. Indexable,
  shareable, no auth required. Long-form **investigations** with methodology,
  data, and findings, some frozen at publish time, some live-querying the
  database (see [ADR-0007](docs/adr/0007-investigation-authoring-and-data-freshness.md)).

See [`CONTEXT.md`](CONTEXT.md) for the full domain vocabulary.

---

## Tech stack

### Current

| Layer                | Choice                                     | Notes                                                                                        |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Framework            | **Next.js 16** (App Router) + **React 19** | SSR/RSC analytical views                                                                     |
| Language             | **TypeScript 5**                           |                                                                                              |
| Styling              | **Tailwind CSS 4**                         |                                                                                              |
| Database             | **Neon** serverless **Postgres**           | accessed via `@neondatabase/serverless`                                                      |
| ORM / migrations     | **Drizzle ORM** + **drizzle-kit**          | schema-as-code is the canonical reference                                                    |
| Auth                 | **Clerk**                                  | three-tier model: public / authed / admin ([ADR-0005](docs/adr/0005-three-tier-auth.md))     |
| Historical ingestion | **Python** (`uv`-managed)                  | one-shot local backfill ([ADR-0008](docs/adr/0008-ingestion-runtime-and-python-boundary.md)) |
| Hosting / CI         | **Vercel**                                 | push-to-deploy from `main`                                                                   |

### Upcoming

- **Parquet-in-Node weekly ingestion**: a Vercel cron streaming nflverse
  parquet directly in the Node runtime, writing `game` / `drive` / `play` /
  `teamWeekStats` from 2026 Week 1 forward ([ADR-0008](docs/adr/0008-ingestion-runtime-and-python-boundary.md),
  [ADR-0016](docs/adr/0016-phase-3b-cron-trigger-and-retry.md)).
- **The Odds API**: live betting lines feeding the Slate Dashboard and Game
  Detail Page.
- **MDX research pipeline**: snapshot + live-query chart components for
  publishing investigations.

---

## Architecture

The guiding decisions (all captured under [`docs/adr/`](docs/adr/)):

- **Read-side only** ([ADR-0001](docs/adr/0001-read-side-only.md)): the DB stores
  facts and derivations, never user artifacts.
- **Vertical slices, engine-first** ([ADR-0010](docs/adr/0010-v1-build-sequence.md)):
  each slice exercises every layer (ingestion → schema → query → view → auth →
  deploy) so integration risk surfaces in slice one, not at the end. The data
  _engine_ (real ingestion + EPA + ELO) is built before the views that consume
  it, so views are never written against synthetic data.
- **In-house MOV-ELO** ([ADR-0014](docs/adr/0014-v1-elo-methodology-consolidated.md),
  [ADR-0022](docs/adr/0022-elo-application-notes-and-tie-correction.md)): a
  margin-of-victory-adjusted ELO computed from scratch, not borrowed.
- **EPA aggregation** ([ADR-0020](docs/adr/0020-epa-aggregation-methodology.md))
  with a load-bearing **defensive-EPA sign convention** ([ADR-0002](docs/adr/0002-edge-computation-and-top-edge-selection.md)):
  strong defenses carry _negative_ EPA; read it before touching any code that
  combines offensive and defensive EPA.
- **Strength of schedule** ([ADR-0023](docs/adr/0023-strength-of-schedule-methodology.md)):
  a 1–32 rank where **1 = hardest**, with separate realized (in-season) and
  projected (week-0) measures.
- **Idempotent, backup-first ingestion** ([ADR-0015](docs/adr/0015-phase-3a-scope-and-forward-only-play-drive.md),
  [ADR-0024](docs/adr/0024-phase-3a-backup-branch-sequencing.md)): writes are
  re-runnable and sequenced behind a backup branch.

### Documentation map

| Document                                             | Role                                               |
| ---------------------------------------------------- | -------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md)  | agent operating instructions & current build state |
| [`db/schema.ts`](db/schema.ts)                       | the schema as it actually **is** (canonical)       |
| [`docs/schema-design.md`](docs/schema-design.md)     | **why** the schema is shaped this way              |
| [`docs/parquet-mapping.md`](docs/parquet-mapping.md) | nflverse parquet → Postgres source specifics       |
| [`docs/adr/`](docs/adr/)                             | one architectural decision per file                |
| [`CONTEXT.md`](CONTEXT.md)                           | domain language & product framing                  |

---

## Deployment

Hosted on **Vercel**, deployed by push to `main` (Vercel's Git integration
builds and promotes automatically; there is no GitHub Actions workflow in this
repo). The database is a **Neon** serverless Postgres branch; production and dev are separate Neon branches, and ingestion writes are validated by diffing a
prod verifier run against dev's known-good output
([`scripts/verify-phase3a.mjs`](scripts/verify-phase3a.mjs)).

---

## Getting started

```bash
# install
npm install

# environment: provide DATABASE_URL (Neon) and Clerk keys
cp .env.example .env.local   # then fill in values

# database
npm run db:generate          # generate migrations from schema.ts
npm run db:migrate           # apply migrations
npm run db:seed              # seed realistic dashboard data
npm run db:studio            # browse the DB in Drizzle Studio

# develop
npm run dev                  # http://localhost:3000
```

The historical backfill is a self-contained `uv`-managed Python project under
[`scripts/backfill/`](scripts/backfill/); see its own README.

---

## Project status

Building toward a **v1 ship** along [ADR-0010](docs/adr/0010-v1-build-sequence.md)'s slice sequence.

- ✅ **Slice 1**: _deployed._ Schema, `weekSummary` view, hand-seeded data,
  three-tier Clerk auth, Slate Dashboard skeleton.
- 🚧 **Slice 3: team-level ingestion + MOV-ELO** _(in progress)_
  - ✅ **Phase 3a (historical backfill)**: complete and live on prod. Local
    Python one-shot computing 2021–2025 plus the 2026 Week-0 ELO baseline:
    MOV-ELO, EPA aggregation, strength-of-schedule, idempotent + backup-first
    write. Prod matched dev line-for-line; verifier passed 21/0.

### What's next

1. **MOV-ELO methodology investigation** (`/research/elo-methodology`): the first
   research-section publish, derisking the MDX pipeline. (Gate: verify the
   HFA-in-MOV "matches FiveThirtyEight" claim against 538's published methodology
   before publishing. See [ADR-0022 §2](docs/adr/0022-elo-application-notes-and-tie-correction.md).)
2. **Phase 3b**: the Vercel weekly cron writing `game` / `drive` / `play` /
   `teamWeekStats` from 2026 Week 1 forward, consuming Phase 3a's baseline.
3. **Slice 4**: player-level ingestion + denormalised opponent-rank fields
   (lights up the Player Page).
4. **Slice 5**: The Odds API (line columns on the Slate Dashboard + Game Detail).
5. **Slices 6–9**: the page slices: Game Detail, Player, Props, Team + Team
   Leaderboard.

---

## Why I built this

I'd already been doing this work for years by hand, in Google Sheets, across
several tabs that I clicked through every week to prep picks and game-watching
notes for me and my friends. The spreadsheet got the job done, but it had a
ceiling: the data was shallow, the formulas were fragile, and any question I couldn't squeeze into the existing columns simply went unanswered.

I wanted to **upgrade the analysis, not just digitize the spreadsheet**. That
meant a robust, queryable data set built on real play-by-play data, derived
metrics I trust (EPA-based matchup edges, an in-house ELO), and a guided
slate → game → player → prop workflow that replaces tab-switching with
navigation. Just as importantly, it gives me a place to actually _answer_ the
questions I'm curious about, like "is last-3-games production actually predictive of the next game, or does it just feel that way?", as proper, written up investigations instead of gut feel.

It's also a deliberate showcase of how I think about data engineering and
product design: schema-first, decision-driven (every non-trivial call is captured as an ADR), and shipped in vertical slices so integration risk surfaces early.
