# Parquet → Postgres field mappings

Source: nflverse `play_by_play_*.parquet` releases. Reader: `hyparquet` (Node). These mappings reflect findings from the pre-Slice-1 ingestion spike — see ADR-0013 for the architectural decisions, this document for the mappings themselves.

## Parquet type quirks

**Dates and times** are BYTE_ARRAY (STRING). Parse at the type boundary during ingestion:

- `game_date` — `YYYY-MM-DD` → JS `Date` (calendar day; persists as Postgres `date`).
- `time` — `MM:SS` (within quarter, e.g. `02:00`) → seconds remaining (persists on `play.timeRemainingSeconds` as integer).
- `time_of_day` — ISO timestamp, e.g. `2025-09-07T18:12:20.900Z` → JS `Date` (persists as Postgres `timestamptz`).

**Boolean-like flags** are stored as DOUBLE (0.0 / 1.0) and need explicit conversion to boolean:

- `pass`, `rush`, `complete_pass`, `interception`, `success`
- `drive_inside20`, `drive_ended_with_score`
- (and any future 0/1 indicator added by nflverse — convert at the type boundary, do not store as numeric)

**Score state** has three distinct representations on every play row:

- `home_score` / `away_score` — *final* score of the game, replicated on every row. Useful for joining game-level results but **not** for in-game state.
- `total_home_score` / `total_away_score` — in-game score at the time of the play, from a fixed home/away frame.
- `posteam_score` / `defteam_score` — in-game score from the possession-team perspective.

v1 stores `posteam_score`/`defteam_score` on `play.scoreOffense`/`scoreDefense`. The analytical use ("how does play-calling change when trailing by 7 vs leading by 7") reads naturally from the possession-team vantage.

**Weather** is partially denormalised. nflverse provides both a free-text and a structured representation:

- `weather` (STRING) — free-text, e.g. `Sunny Temp: 83° F, Humidity: 72%, Wind: NE 9 mph`. Ignored.
- `temp` (INT32, nullable) — structured. Always null for domes.
- `wind` (INT32, nullable) — structured. Always null for domes.

Use the structured fields. The free-text version is preserved by nflverse for completeness but is not parsed.

## Drive field mappings

`fixed_drive` is the canonical drive identifier — it respects mid-game corrections. The raw `drive` column is preserved by nflverse for compatibility and is ignored.

| Parquet column                | Schema target              |
| ----------------------------- | -------------------------- |
| `fixed_drive`                 | `drive.driveNumber`        |
| `fixed_drive_result`          | `drive.result`             |
| `drive_play_count`            | `drive.playCount`          |
| `drive_time_of_possession`    | `drive.timeOfPossession`   |
| `drive_first_downs`           | `drive.firstDowns`         |
| `drive_inside20` (0/1)        | `drive.insideTwenty` (bool) |
| `drive_ended_with_score` (0/1)| `drive.endedWithScore` (bool) |

Drive data is replicated on every play row in the parquet. Ingestion deduplicates by `(gameId, fixed_drive)` before inserting `drive` rows.

## Play field mappings

| Parquet column        | Schema target                  |
| --------------------- | ------------------------------ |
| `success` (0/1)       | `play.isSuccessful` (bool)     |
| `cpoe`                | `play.cpoe`                    |
| `xpass`               | `play.xpass`                   |
| `pass_oe`             | `play.passOverExpected`        |
| `posteam_score`       | `play.scoreOffense`            |
| `defteam_score`       | `play.scoreDefense`            |
| `ep`                  | `play.expectedPointsBefore`    |

Additional play-level mappings will be added as ingestion lands per slice. This document is the source of truth for parquet → Postgres column correspondence; the schema's `play` table declares the destination columns in `src/db/schema.ts`.
