# Parquet → Postgres field mappings

Source: nflverse `play_by_play_*.parquet` releases. Reader: `hyparquet` (Node). These mappings reflect findings from the pre-Slice-1 ingestion spike — see ADR-0013 for the architectural decisions, this document for the mappings themselves.

## Parquet type quirks

**Dates and times** are BYTE_ARRAY (STRING). Parse at the type boundary during ingestion:

- `game_date` — `YYYY-MM-DD` → JS `Date` (calendar day; persists as Postgres `date`).
- `time` — `MM:SS` (within quarter, e.g. `02:00`) → seconds remaining (persists on `play.timeRemainingSeconds` as integer).
- `time_of_day` — ISO timestamp, e.g. `2025-09-07T18:12:20.900Z` → JS `Date` (persists as Postgres `timestamptz`).

**Boolean-like flags** are stored as DOUBLE (0.0 / 1.0) and need explicit conversion to boolean:

- `pass`, `rush`, `pass_attempt`, `rush_attempt`, `complete_pass`, `qb_dropback`, `qb_scramble`, `two_point_attempt`, `shotgun`, `no_huddle`, `qb_hit`, `success`
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
| `drive_time_of_possession`    | `drive.timeOfPossession` — `MM:SS` → **integer seconds** (aggregatable; same conversion as `play.time`) |
| `drive_first_downs`           | `drive.firstDowns`         |
| `drive_inside20` (0/1)        | `drive.insideTwenty` (bool) |
| `drive_ended_with_score` (0/1)| `drive.endedWithScore` (bool) |

Drive data is replicated on every play row in the parquet. Ingestion deduplicates by `(gameId, fixed_drive)` before inserting `drive` rows.

## Play field mappings

The Phase 3b `play` column list is finalised here (forward-only per ADR-0015; the table is created by `drizzle/0002_*`). The surrogate PK `play.id` has no parquet source.

**Resolved references (looked up at ingest, not stored raw):**

| Parquet column   | Schema target           | Resolution                                                                 |
| ---------------- | ----------------------- | -------------------------------------------------------------------------- |
| `game_id`        | `play.gameId`           | → `game.id` via `game.nflverseGameId`                                      |
| `fixed_drive`    | `play.driveId`          | → `drive.id` via `(game_id, fixed_drive)` (the drive deduped per ADR-0013) |
| `season`         | `play.seasonId`         | → `season.id` via `season.year`                                            |
| `posteam`        | `play.posteamTeamId`    | → `team.id` via exact-match `team.abbreviation` (ADR-0026 decision B; unknown abbr = loud-fail at the gate/retry boundary, not a stored token) |
| `defteam`        | `play.defteamTeamId`    | → `team.id` via exact-match `team.abbreviation`                            |

`season`/`week` are denormalised onto `play` (ADR-0018 descriptor set) so `aggregate_week`'s season-to-date scan filters on `play` without a join (ADR-0026).

**Identity / ordering:**

| Parquet column   | Schema target        | Notes                                  |
| ---------------- | -------------------- | -------------------------------------- |
| `play_id`        | `play.playId` (int)  | `(game_id, play_id)` is the upsert key |
| `order_sequence` | `play.orderSequence` | nflfastR canonical within-game sort key |
| `week`           | `play.week`          |                                        |

**Participants** (ADR-0018 query-proven; raw nflverse text, **no FK** — the `player` table is Slice 4, which adds the FK and resolves text→player_id then (resolved in ADR-0031)):

| Parquet column       | Schema target            |
| -------------------- | ------------------------ |
| `rusher_player_id`   | `play.rusherPlayerId`    |
| `rusher_player_name` | `play.rusherPlayerName`  |
| `receiver_player_id` | `play.receiverPlayerId`  |
| `receiver_player_name`| `play.receiverPlayerName`|
| `passer_player_id`   | `play.passerPlayerId`    |
| `passer_player_name` | `play.passerPlayerName`  |

**Classification flags** (DOUBLE 0/1 → boolean). `pass`/`rush` are ADR-0020's EPA universe; `two_point_attempt` is its exclusion:

| Parquet column      | Schema target          |
| ------------------- | ---------------------- |
| `pass`              | `play.pass`            |
| `rush`              | `play.rush`            |
| `pass_attempt`      | `play.passAttempt`     |
| `rush_attempt`      | `play.rushAttempt`     |
| `complete_pass`     | `play.completePass`    |
| `qb_dropback`       | `play.qbDropback`      |
| `qb_scramble`       | `play.qbScramble`      |
| `two_point_attempt` | `play.twoPointAttempt` |
| `shotgun`           | `play.shotgun`         |
| `no_huddle`         | `play.noHuddle`        |
| `qb_hit`            | `play.qbHit`           |
| `success`           | `play.isSuccessful` (= `epa>0`; stored as ergonomics convenience) |

**Situational descriptors:**

| Parquet column  | Schema target               | Notes                                          |
| --------------- | --------------------------- | ---------------------------------------------- |
| `down`          | `play.down` (smallint)      |                                                |
| `ydstogo`       | `play.yardsToGo` (smallint) |                                                |
| `qtr`           | `play.quarter` (smallint)   |                                                |
| `time`          | `play.timeRemainingSeconds` | `MM:SS` within quarter → integer seconds       |
| `run_location`  | `play.runLocation`          |                                                |
| `run_gap`       | `play.runGap`               |                                                |
| `pass_location` | `play.passLocation`         |                                                |
| `pass_length`   | `play.passLength`           |                                                |

**Yardage** (`passing_yards`/`rushing_yards` are the box-score universe — exclude 2pt — summed by `teamWeekStats`' traditional aggregates per build.py / ADR-0020):

| Parquet column      | Schema target          |
| ------------------- | ---------------------- |
| `yards_gained`      | `play.yardsGained`     |
| `passing_yards`     | `play.passingYards`    |
| `rushing_yards`     | `play.rushingYards`    |
| `receiving_yards`   | `play.receivingYards`  |
| `air_yards`         | `play.airYards`        |
| `yards_after_catch` | `play.yardsAfterCatch` |

**Score state** (possession-team frame, ADR-0013) and **base model outputs** (ADR-0018 Volatility test):

| Parquet column  | Schema target                  |
| --------------- | ------------------------------ |
| `posteam_score` | `play.scoreOffense`            |
| `defteam_score` | `play.scoreDefense`            |
| `epa`           | `play.epa`                     |
| `air_epa`       | `play.airEpa`                  |
| `wpa`           | `play.wpa`                     |
| `cpoe`          | `play.cpoe`                    |
| `xpass`         | `play.xpass`                   |
| `pass_oe`       | `play.passOverExpected`        |
| `ep`            | `play.expectedPointsBefore`    |

**ADR-0018 is the governing principle for *which* play columns earn a Postgres column** (the Descriptor / Volatility tests and the Excluded list); this document is its *application* — the source of truth for *how* each captured column maps parquet → Postgres. `home_team`/`away_team` and the reconstructable rollups / derivable companions ADR-0018 excludes are reachable via the `game` FK or the durable parquet, never stored on `play`. The schema's `play` table declares the destination columns in `db/schema.ts`.
