# Production parquet reader: hyparquet for schedule + pbp — amends ADR-0008

ADR-0008 fixed the production ingestion runtime (Vercel cron, parquet-in-Node, no Python in
production) and named **`apache-arrow` / `parquetjs`** as the candidate Node parquet readers.
That naming was provisional — written before any reader was exercised against real nflverse
data. This ADR settles it: **production parquet reads use `hyparquet`, for both the schedule
and the play-by-play, pulled from the nflverse-data GitHub release parquet over HTTP.** The
runtime decision in ADR-0008 is unchanged; only the library naming is superseded.

## Decision

- **One reader: `hyparquet`.** It reads both nflverse inputs — the schedule and the
  play-by-play — over HTTP from the nflverse-data release assets, column-filtered to the
  mapped columns to keep fetches small.
- **The release assets (confirmed 200 over HTTP, the same releases Phase 3a's `nfl_data_py`
  resolves to):**
  - Schedule — `https://github.com/nflverse/nflverse-data/releases/download/schedules/games.parquet`
    (a single all-seasons asset; filter by the `season` column).
  - Play-by-play — `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{year}.parquet`
    (one asset per season).
- **Game-scoped pbp read is the v1 lean (ADR-0026 deferral):** pull the season pbp parquet
  and filter rows to a target `game_id` **in memory**. Column-selection (narrowing which
  columns are fetched) is applied now and is unrelated to row filtering. Row-**group**
  predicate pushdown on `game_id` is the deferred optimization — unconfirmed the parquet's
  row-group ordering would even let pushdown skip groups, so it is revisited only if the 300s
  drain budget tightens (ADR-0026). The reader is structured so pushdown can be added later
  without reshaping callers.

## Why hyparquet over the ADR-0008 naming

- **Already validated.** The ADR-0013 spike exercised `hyparquet` against a real
  current-season play-by-play release end-to-end (schema parse, type quirks, value ranges)
  and found no friction — it is the precedent ADR-0008's contingency was waiting on.
- **`parquetjs` is effectively unmaintained** (~7 years since a substantive release) — not a
  basis for a production data path.
- **pbp is parquet-only, so hyparquet is required regardless.** Given that, standardizing the
  *schedule* read on the same library — rather than adding a second reader or a CSV path — is
  the lower-surface-area choice: one library, one source, one set of parsing conventions
  (ADR-0013). This is the same minimize-the-production-runtime logic ADR-0008 used to reject a
  second language; it applies identically to a second parquet library.

## Parsing conventions (unchanged, carried from ADR-0013)

hyparquet's typed accessors do **not** auto-convert several nflverse encodings; the reader
applies these at the type boundary (already documented in ADR-0013 and `docs/parquet-mapping.md`):

- Booleans stored as DOUBLE `0/1` → explicit boolean conversion.
- Dates/times as BYTE_ARRAY strings (`game_date` `YYYY-MM-DD`, `time` `MM:SS`, `time_of_day`
  ISO; the schedule's `gameday`/`gametime` likewise).
- The three score representations kept distinct (`home_score`/`away_score` final;
  `total_home_score`/`total_away_score` in-game; `posteam_score`/`defteam_score` possession-frame).
- `fixed_drive` is the canonical drive number, not the raw `drive` column.

## Scope and boundary

This ADR governs **reading + parsing** only. The shared reader returns rows carrying raw
nflverse team **abbreviations** and performs no resolution and no DB writes. Abbreviation →
`team_id` resolution (exact-match, loud-fail) and all persistence belong to the `ingest_game`
handler (ADR-0026 / `docs/parquet-mapping.md`).

## Relationship to ADR-0008 — amends, not reversal

ADR-0008's load-bearing decisions all stand: Vercel-cron runtime, parquet-in-Node (no Python
in production), the `jobQueue` chunking, and the Python-backfill / GitHub-Action escape hatch.
Only the provisional `apache-arrow` / `parquetjs` naming is superseded. A dated back-reference
note is added to ADR-0008 pointing here, so a future reader of its "reading nflverse parquet
releases directly in Node" paragraph is routed to the settled library choice.

## Cross-references

- ADR-0008 — the ingestion runtime + Python boundary this amends (library naming only).
- ADR-0013 — the parquet-in-Node spike that validated hyparquet; the parsing conventions.
- ADR-0026 — the per-game pbp read strategy / row-group-pushdown deferral; the 300s budget.
- ADR-0028 — discovery is schedule-only (the schedule read this reader serves); pbp is the
  `ingest_game` handler's input.
- `docs/parquet-mapping.md` — the parquet → Postgres column mappings the reader projects onto.
