# Play-table column-inclusion principle

The forward-only `play` table (ADR-0015) is greenfield — it does not yet exist in `db/schema.ts`, and Phase 3b will create it from scratch. Before it does, this ADR settles the *principle* for which of nflverse play-by-play's ~370 columns earn a Postgres column, so the table is designed deliberately rather than reaching for whatever the first ingestion pass happens to need. The concrete column list is the *application* of this principle and lives in `docs/parquet-mapping.md`, finalised when Phase 3b builds the table; this ADR is the durable rule that every future "should we capture column X?" runs through, in the same way ADR-0009 and ADR-0011 govern derived-metric placement.

## Two layers, two purposes

The decision rests on a two-consumer split that already existed in the design but was never named:

- The **Postgres `play` table is the online serving layer** for read-time splits (ADR-0009). Its reason to exist is to be queried at request time to render directional / locational / situational breakdowns on player and team pages.
- The **durable nflverse parquet is the research-and-backfill layer** (ADR-0015). Any column not in Postgres remains reachable on demand via ad-hoc duckdb / pandas reads, and any column we later wish we had captured recovers via `ALTER TABLE ADD COLUMN` + a one-shot backfill from the same durable releases.

Grounding the column set in the serving layer's *purpose* — "what would a plausible read-time split filter or group by?" — rather than in any specific downstream feature (e.g. the Slice 6+ Player Page) is deliberate. Features are speculative and shift; the analytical surface of play-by-play is stable and enumerable. The play table's purpose *is* to serve splits, so letting "what splits" inform the columns is the dog, not the tail.

## The inclusion test

A source column earns a Postgres column if it passes **one** of:

- **Descriptor test** — it is a non-redundant, revision-*stable* descriptor of what happened on the play (participants, field location / direction, down / distance / clock, play type, formation / tempo / pressure context, outcome) that a plausible read-time split would filter or group by.
- **Volatility test** — it is a non-reconstructable *base* model output whose values drift across nflverse pipeline runs, so capturing it at ingestion buys row-internal pipeline consistency a late backfill cannot reproduce. ADR-0019's write-once posture is what makes this test load-bearing; under a re-ingesting posture it would largely collapse into the Descriptor test.

Read the **Descriptor test at its natural breadth**, not narrowed to columns some query has already exercised. Because the cut is reversible (see meta-rule), there is no reason to withhold a plain play-context descriptor merely because no analysis has touched it yet. "Capture the analytical vocabulary, then write queries against it" is the correct order, not the reverse.

## Tier-A: grounded in exercised queries, marked for honesty

The Tier-A "always capture" set is grounded empirically in the columns the pre-Slice-1 analytical spike (`parquet-spike`) actually queries — directional rushing EPA, target-based passing EPA, defensive rushing EPA by direction — supplemented by the descriptor family those analyses imply.

**Query-proven** (referenced by spike queries today): `game_id`, `season`, `week`, `home_team` / `away_team`, `posteam`, `defteam`, `order_sequence` (nflfastR's canonical within-game sort key), `play_id`; `rusher_player_id` / `_name`, `receiver_player_id` / `_name`, `passer_player_id` / `_name`; `rush_attempt`, `pass_attempt`, `complete_pass`, `qb_dropback`, `qb_scramble`; `run_location`, `run_gap`; `yards_gained`, `receiving_yards`; `epa`, `success`.

**Query-pending** (pass the Descriptor test; no spike query exercises them yet): `pass_location`, `pass_length`, `air_yards`, `yards_after_catch` (the receiving-side mirror of the rushing directional family); `shotgun`, `no_huddle` (formation / tempo); `qb_hit` (pressure); `posteam_score` / `defteam_score` (in-game possession-frame score *before* the play — already the ADR-0013 capture into `play.scoreOffense` / `scoreDefense` — enabling score-differential and game-script splits such as trailing / leading and garbage-time filtering; `score_differential` is derivable from the pair). These are captured, not deferred — the `query-pending` label records honesty about current usage, it is not a gate on capture.

The split between query-proven and query-pending carries no schema consequence; both are captured. It exists only so a future reader can tell "we use this" from "the principle says we will."

## Volatility test: the base set

Model outputs are the columns most subject to cross-pipeline-run variation, so we lean generous toward them — but only toward the *non-reconstructable base*, not derived rollups of it. The base set is **`epa`, `air_epa`, `wpa`, `cpoe`, `xpass`, `pass_oe`**. Derivable companions are excluded or stored only as conveniences: `success` = `epa > 0`, `yac_epa` = `epa − air_epa`, `qb_epa` ≈ `epa`. `success` may be stored as a query-ergonomics convenience despite being reconstructable; it is not consistency-load-bearing.

## Excluded — reachable via parquet, never in Postgres

The Descriptor and Volatility tests do the including; this list does the cutting, and the descriptor family's natural breadth is **not** a licence to relax it:

- **Reconstructable rollups** — the cumulative `total_home_*` / `total_away_*` EPA columns (running totals, recomputable by summation over captured rows).
- **Derivable model companions** — `yac_epa`, `qb_epa`, and `success` qua derived value (derivable from the base set).
- **Exotic model internals** — `xyac_epa`, `xyac_mean_yardage`, `xyac_success`, and similar expected-value internals: research-tier, parquet-reachable.
- **Redundant source representations** — the raw `drive` column (superseded by `fixed_drive`, which survives as `drive.driveNumber` per ADR-0013; neither raw parquet column lands on `play` — the FK is the surrogate `play.driveId`); the free-text `weather` string (structured `temp` / `wind` used instead); the replicated **final**-score columns (`home_score` / `away_score`, and the game-level `result` / `total`), redundant with the `game` table — the spike read `home_score` / `away_score` from the standalone parquet only because it had no `game` table to join, but `play` does; and the fixed home/away-frame running score (`total_home_score` / `total_away_score`), a redundant framing of the possession-frame in-game score that *is* captured via `posteam_score` / `defteam_score` per ADR-0013.
- **Bookkeeping and irrelevant metadata** — internal nflverse IDs with no analytical read path, `home_coach` / `away_coach`, stadium / venue metadata, and similar presentation or provenance fields.

## Meta-rule: reversible cut, no defensive maximalism

The cut is cheaply reversible in *both* directions — under-capture recovers via `ADD COLUMN` + a season-consistent backfill from the durable parquet (ADR-0015's blessed pattern); over-capture recovers via `DROP COLUMN`. Because mistakes are cheap both ways, make the principled cut and move on.

The durable-parquet backstop is what licenses a clean analytical cut rather than a "grab all ~370 columns to be safe" reflex. "Near-zero marginal cost to map one more column" is precisely the reasoning that, unchecked, justifies capturing everything; the backstop is the brake on it. Capture what the tests include, map the obvious descriptor family at its natural breadth because the parser has those columns in hand anyway, and let the durable parquet be the backstop for everything else.

## Update 2026-06-30: player-identity resolution deferred to Slice 4 (see ADR-0031)

The participant columns above (`rusher_player_id` / `_name`, `receiver_player_id` / `_name`,
`passer_player_id` / `_name`) land on `play` as **raw nullable text with no FK** — deliberately.
The `player` table, the FK, and the text→`player_id` resolution are Slice-4 work, not captured
here. That resolution is now settled in **[ADR-0031](0031-player-data-source-and-identity-resolution.md)**:
the `*_player_id` values are GSIS ids, play-by-play is the identity source of record (existence
derived from these columns via an ensure-exists upsert), and the roster/players release enriches
only. A reader of this ADR wondering "where do these raw ids become a resolved player?" is routed
there.
