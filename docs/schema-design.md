# Schema design

**Drizzle is the source of truth.** This document captures the *why* behind the schema's shape — design rationale, recurring patterns, principles, and per-table notes that the Drizzle code can't express. Column types, indexes, and exact field names live in `db/schema.ts`. When Drizzle and this document conflict, Drizzle wins; update this document.

For architectural decisions that warrant their own record, see `docs/adr/`. For the nflverse parquet → Postgres column mappings, see `docs/parquet-mapping.md`.

## Data placement principles

Three principles govern where information lives in the schema. Each is the distillation of a specific decision; each has a corresponding ADR if the decision was hard enough to warrant one.

**Wrong-shape vs just-slow** (ADR-0009). Materialise data when the natural code organisation would produce wrong-shape queries — N+1 lookups, repeated complex joins, dashboard payloads with parallel per-card queries. Do not materialise when the query is just slower than ideal but otherwise correct in shape; Postgres at this scale handles arbitrary single-query splits in single-digit milliseconds. Just-slow is acceptable; wrong-shape is not.

**Derived state at read time** unless temporal-correctness, wrong-shape, or atomicity forces caching. Examples that compute live: current week (`getCurrentWeek(seasonId)` helper), ELO rank within league (`RANK() OVER`), win/loss streak, rest situation between games, hit margin on a prop. Examples that materialise at ingestion: per-game target / rush / air-yards shares, opponent defense rank at time of game, season-to-date totals (ADR-0011). The default is "compute at read time" — caching pays its cost in cascading writes and staleness risk, and earns its keep only when it solves something live computation can't.

**DB stores analytical facts; TS stores presentation/brand.** Analytical team fields (`conference`, `division`, `abbreviation`) live in Postgres because they are queried in analytical contexts. Team brand assets (name, primary colour, secondary colour, logo path) live in `data/teams.ts` as a typed constant. Pure presentation has no place in the read-side analytical store — it adds bytes to every row read, requires migrations to update, and answers no analytical question.

## Recurring patterns

**Snapshot pattern.** Tables of the form `*WeekStats` represent point-in-time state, not records of events. A `teamWeekStats(SEA, 2026, 5)` row says "this is what SEA looks like at end of week 5" — not "here's what happened in week 5." Under that framing, bye weeks get carry-forward rows (state unchanged, here's what it is) and pre-season baselines are encoded as `week = 0` rows (start-of-season state, ELO regression target lives there). The dashboard's "give me SEA's most recent stats" query stays at `WHERE week = ?` with no special cases for byes or week 1.

**Computed-data-artifact split.** When a derived value (matchup edge, prop edge, season aggregate) needs both a published decision and a runtime implementation, the split is three places, each owning one concern: an ADR captures the decision and formula, migration SQL holds the implementation (view body, computed column expression), the route or component just renders the result. For matchup edge specifically: ADR-0002 owns the formula, the `weekSummary` view body owns the SQL implementation, the dashboard route renders pre-computed columns. The dashboard does not re-implement the formula; it consumes the view.

**Parent + snapshot for line history.** `propLineSnapshot` and `gameOddsSnapshot` both follow a parent-plus-snapshot pattern: a parent row identifies the bet, many snapshot rows record line / price observations over time. The pattern is the same for both, which keeps ingestion and rendering code structurally symmetric.

## Drizzle conventions

**Naming**:
- TS-side property names in camelCase (`homeTeamId`, `expectedPointsBefore`).
- Postgres column names in snake_case via `casing: 'snake_case'` in `drizzle.config.ts`. Per-column overrides only for acronyms preserving capitalisation or for matching a specific source-system identifier name.
- **The same `casing: "snake_case"` MUST also be passed to the runtime `drizzle(pool, { schema, casing: "snake_case" })` call** — `drizzle.config.ts`'s casing affects only `drizzle-kit generate`; the runtime client uses its own casing to map property names to columns at query time. Forget the runtime arg and every insert/update fails with "column does not exist." Apply at every `drizzle()` call site (`db/index.ts`, `db/seed.ts`, any future standalone scripts).

**Primary keys and idempotency**:
- Surrogate `bigserial` PKs on every table. One mental model across the schema.
- Natural keys (`season.year`, `team.abbreviation`, `game.nflverseGameId`, `player.gsisId`) declared as UNIQUE NOT NULL columns alongside the PK. These also serve as idempotency keys for ingestion upserts.
- The Odds API event ID is stored on `game.oddsApiEventId` (nullable, populated when odds ingestion sees the matching event).
- `prop` has UNIQUE on `(playerId, gameId, propType)`.
- `team.abbreviation` is plain `text` with a CHECK constraint enforcing 2–4 uppercase letters. Ingestion code normalises to uppercase at the type boundary rather than relying on `citext`.

**Column types**:
- Real-valued analytical columns: `double precision`. Matches the nflverse parquet DOUBLE source type and avoids round-trip rounding noise.
- Counts and ranks: `integer`. Week numbers: `smallint`.
- Small stable enums: `pgEnum` with lowercase snake_case values (`in_progress`, `super_bowl`). Switch to text + CHECK only when value removal will be needed or the source is uncontrolled (e.g. nflverse silently adds a new `play_type`). `ALTER TYPE ADD VALUE` is cheap; frequency of additions alone does not justify text + CHECK.
- Datetimes: `timestamptz` via `timestamp({ withTimezone: true, mode: "date" })`. NFL games cross timezones — naive `timestamp` produces silent drift. Calendar-day fields use plain `date`.
- Strings: `text` everywhere. `varchar(n)` is legacy and functionally identical. Use CHECK constraints when actual length validation matters.

**Schema file organisation**:
- Single `db/schema.ts` until either it crosses ~250 lines or a domain hits a third table. At that point, cut over to `db/schema/{reference,games,player-perf,team-stats,props,odds,injuries,infra}.ts`. Call-site imports stay `import { ... } from "@/db/schema"` either way — the cutover renames the file into a folder with an index re-export, no consumer code touched.
- Section dividers in the single-file version pre-stage the eventual domain split so the cutover is mechanical.
- Drizzle `relations()` declarations co-located with their tables, never split into a separate `relations.ts`. The FK declaration and the relation declaration describe the same edge and want to be read together.

**Migration workflow**:
- `drizzle-kit generate` + `drizzle-kit migrate` from day one. No `push` mode. Migration files become a paper trail of schema evolution that pairs with the ADRs.
- Always read the generated `.sql` before running `migrate` — Drizzle's rename-vs-drop diffs are not always what you'd expect.
- Rename migration files to descriptive names after generation (`0002_add_drive_table.sql`).
- Run migrations against the prod Neon branch *before* deploying code that depends on them.

**Views**:
- View bodies declared in raw SQL inside migration files.
- Drizzle declares views via `pgView(...).existing()` for type-safe consumption.
- `CREATE OR REPLACE VIEW` can add columns at the end but cannot reorder or retype existing ones. Order initial columns deliberately.
- Views grow per slice via `CREATE OR REPLACE VIEW` migrations as their source tables land.

**Indexes**:
- Drizzle does not automatically index foreign-key columns. Every FK gets an explicit index in the table's `pgTable` definition.
- Natural-key UNIQUEs (`season.year`, `team.abbreviation`, `game.nflverseGameId`, `(teamId, seasonId, week)` on `teamWeekStats`, `(playerId, gameId, propType)` on `prop`, etc.) double as indexes — no separate index needed.
- Composite indexes for wrong-shape query patterns are justified per-table when the table lands. Examples that follow established patterns:
  - Snapshot tables (`propLineSnapshot`, `gameOddsSnapshot`, `playerInjuryStatus`): composite on `(parentId, capturedAt)` (or `reportedAt`) for time-ordered access.
  - Rank-based splits on `playerGame`: three-column composites including `opponentDefenseRank*` columns (see ADR-0011 for the wrong-shape mechanism).
  - Weekly queries on `game`: composite on `(seasonId, week)`.

## Per-table rationale

### Reference data

**`season`** — Immutable facts about a season's existence: `(id, year, startDate, endDate)`. `currentWeek` and `isComplete` are not stored — both are derived state computed via `getCurrentWeek(seasonId)` (data placement principle #2).

**`team`** — Analytical fields only: `(id, abbreviation, conference, division)`. Brand assets (name, colours, logo) live in `data/teams.ts`. A `homeStadiumId` FK was considered for v1 but dropped per YAGNI — the column had no read path and no FK target (stadium ships in a future slice). When stadium lands, `team.homeStadiumId` and `game.stadiumId` get added as nullable FKs via an `ALTER TABLE` migration; the `team.homeStadiumId`↔`stadium.homeTeamId` circular FK gets resolved then by picking one canonical direction.

**`stadium`** — Separated from `team` to handle neutral-site games (international, Super Bowl, weather relocations). `homeTeamId` is nullable for neutral-site-only venues. Lands in a future slice; `team` and `game` gain stadium FKs at that point.

**`player`** — Attributes that don't change frequently (name, position, jersey number, height/weight, DOB, rookie year, headshot). Team affiliation tracked separately via `playerTeamMembership` to handle mid-season trades. `gsisId` UNIQUE NOT NULL serves as ingestion idempotency key.

**`playerTeamMembership`** — `(playerId, teamId, startDate, endDate)`. One active membership per player at a time but multiple over a career. Mid-season trades produce a closing row for the old team and an opening row for the new team.

### Games

**`game`** — Per-game facts plus weather (denormalised because weather is always read alongside game data). In-progress live scores are deliberately not stored — the live-score badge fetches from ESPN on demand per ADR-0006. `nflverseGameId UNIQUE NOT NULL` from day one for ingestion idempotency. `oddsApiEventId` nullable, populated when odds ingestion sees the matching event.

**`drive`** — Top-level table extracted from per-play drive context replicated in the parquet. See ADR-0013 for the modelling decision. UNIQUE on `(gameId, driveNumber)` enforces post-deduplication uniqueness.

**`play`** — The foundation for EPA, advanced metrics, and ad-hoc research queries. References `driveId`. EPA fields ingested from nflfastR pre-computed values per ADR-0003 — building a custom EPA model is a v2 research investigation, not a v1 dependency.

### Player performance

**`playerGame`** — Per-player per-game stats plus pre-computed shares (target / rush attempt / air yards), opponent defense rank at time of game, and season-to-date totals. The materialised denormalisations follow ADR-0011's wrong-shape mechanism: rank-based splits otherwise require self-joins against `teamWeekStats`; season-to-date window functions are bug-prone on read.

**`playerSeasonStats`** — Pre-aggregated season totals and per-game averages. Read on essentially every player-facing page, which passes the wrong-shape test by virtue of frequency.

### Team rolling stats

**`teamWeekStats`** — The snapshot table for team state (see "Recurring patterns" → snapshot pattern). Carries EPA across phases, ELO (computed in-house per ADR-0004), SOS, record, and traditional offensive / defensive aggregates. UNIQUE on `(teamId, seasonId, week)`. Defensive EPA stored as "what they allow" per ADR-0002's sign convention.

All stat columns are NOT NULL — rows exist only for completed weeks. Bye weeks get carry-forward rows (snapshot pattern), week-0 rows are inserted at season start as pre-Week-1 baselines. `eloRankInLeague` is *not* a column — computed via `RANK() OVER (ORDER BY eloRating DESC)` at read time.

### Props and odds

**`prop` + `propLineSnapshot`** — Parent + snapshot pattern for prop line history. `actualValue` on the parent populated post-game. UNIQUE on `(playerId, gameId, propType)`.

**`gameOdds` + `gameOddsSnapshot`** — Same shape applied to game-line markets. `marketType` on the parent partitions rows into spread / moneyline / total. The snapshot row currently has fields for all three market types but only the columns matching the parent's `marketType` are populated — flagged as a smell to revisit when the odds slice actually lands; either splitting into three snapshot tables or moving the polymorphic fields into a JSONB column are the options on the table.

### Injuries

**`playerInjury`** — Per-injury record with initial report and resolution dates. Separated from `player` because a player can have multiple injuries per season.

**`playerInjuryStatus`** — Weekly status updates against the parent injury. Status enum includes `activated` to mark recovery; the parent's `resolvedDate` is set when status transitions to `activated`.

### Ingestion infrastructure

**`jobQueue`** — Chunked work pattern per ADR-0008. Each pending row is one unit of work; cron drains as many as fit in the 300s Vercel function window. Crash-safe by construction.

### Views

**`weekSummary`** — The Slate Dashboard's read shape. One row per game per week with both teams' EPA, records, SOS, weather, most-recent line snapshot, and computed top edge value + label. ADR-0009 establishes the view-as-read-shape pattern; ADR-0002 specifies the edge formula. The view's column set grows as subsequent slices add source tables — Slice 1 ships a smaller shape with just `teamWeekStats`-derived columns + the edge computation. Future slices `CREATE OR REPLACE VIEW` to add the line snapshot column, the weather columns, and so on.

## Ingestion order

Weekly ingestion sequence after games complete (triggered Sunday/Monday/Thursday nights ~30 minutes after final game ends — see ADR-0006):

1. Update `game` records with final scores.
2. Process play-by-play parquet: extract unique drives per game and upsert into `drive`, then insert plays into `play` with `driveId` FK references. Drive data is replicated on every play row in the parquet, so deduplicate by `(gameId, driveNumber)` before drive inserts.
3. Compute and update `teamWeekStats`: EPA aggregates from plays, ELO recalculation (depends on prior week's ELO + this week's results), SOS update, traditional stat aggregates. Bye-week detection runs here — teams with no game this week get carry-forward rows.
4. Update `playerGame` records: per-player per-game stats from box scores, computed `targetShare` / `rushAttemptShare` / `airYardsShare` from team totals, denormalised `opponentDefenseRank*` from `teamWeekStats` (step 3 must complete first), and `seasonToDate*` totals from prior games.
5. Update `playerSeasonStats`: roll up `playerGame` rows into season aggregates.
6. Update injury reports.
7. Update prop and odds `actualValue` / `actualResult` for completed games.

Pre-season (once, before Week 1):
- Seed `teamWeekStats` rows with `week = 0` for all 32 teams. ELO regression target lives here.

Continuous (multiple times per week during active windows):
- Snapshot prop lines from The Odds API.
- Snapshot game odds from The Odds API.
- Update upcoming game weather forecasts (Open-Meteo).
- Update injury status reports.

On-demand (page render):
- Live-score badge: ESPN hidden API for in-progress games, cached 30s.

Manual (admin write UI per ADR-0003):
- Corrections to any table where automated ingestion has gaps. Particularly load-bearing for injury reports and post-game weather corrections on outdoor games.

One-time / rare (local Python scripts in `scripts/backfill/`, not deployed):
- Historical backfill, run from laptop, writes directly to Neon. See ADR-0008.
