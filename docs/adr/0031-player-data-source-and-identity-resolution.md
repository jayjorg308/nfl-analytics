# Player-data source and identity resolution: pbp-as-identity-of-record, roster-as-enrichment

Slice 4 (ADR-0010) adds player-level ingestion. This ADR settles two coupled questions that
the source decision cannot be ratified without: **where player facts and player identity come
from**, and **how an nflverse text player id resolves to a `player` row** when the set of
players is never known-complete at ingestion time. The two are one decision — the
unknown-player policy *is* what makes the identity source of record concrete — so they land in
one ADR.

ADR-0011 governs *where* the derived player metrics are stored (per-game `playerGame`,
denormalise-at-ingestion) but is **silent on source**; this ADR is the source decision it left
open, not an amendment to it. ADR-0018 captured the raw participant ids/names on `play` as
nullable text with no FK and deferred "the `player` table + the text→player_id resolution" to
Slice 4; **this ADR is that resolution.**

## Context

- The play-by-play the forward pipeline already pulls (ADR-0029, via `hyparquet`) lands, on
  every `play` row, `rusher_player_id` / `receiver_player_id` / `passer_player_id` and their
  `_name` companions (`lib/ingestion/pbp.ts`, `docs/parquet-mapping.md`). The `*_player_id`
  values are **GSIS ids** (`00-00XXXXX`) — the same key the nflverse players/rosters releases
  join on.
- The MVP scope is **offensive skill positions only** (QB / RB / WR / TE — exactly the
  rusher / receiver / passer participants pbp carries).
- The existing team resolver (`ingest_game`'s `loadTeamMap` / `resolveTeam`) **loud-fails on an
  unknown abbreviation** — sound because the 32 teams are a fixed, known-complete dimension
  seeded once. Players are **not** known-complete at any frozen instant (rookies, practice-squad
  elevations, mid-season signings surface in pbp continuously), so porting loud-fail unchanged
  would stall an entire game's ingest the first time an un-rostered player appears.

## Decision

**1. Source split.**
- **Play-by-play parquet is the source of record for both player FACTS and player IDENTITY.**
  Facts aggregate natively to per-game rows (`playerGame`, ADR-0011-consistent). Identity is
  derivable from the fact source itself, because ADR-0018 already lands `(gsis_id, name)` on
  every participating `play` row.
- **The nflverse roster/players release is ENRICHMENT only** — position, canonical name, team.
  It is spike-first and **non-blocking**: the MVP lights the Player Page on pbp-only identity;
  enrichment lands whenever its spike does.

**2. Unknown-player policy — upsert-on-miss (loud-fail retired for players).**
On the `ingest_game` drain path, collect the **distinct `(gsis_id, name)` set across the three
role columns** over all of the game's plays — a Set of cardinality 0–N, not a fixed-arity pair
(the true per-play maximum is a confirm-against-pbp detail, not a bound worth encoding into the
type) — and upsert each with `INSERT … ON CONFLICT (gsis_id) DO NOTHING`. This is the **ensure-exists shape of ADR-0027(B)**
(the enqueue-dedup guard), **not** the `excludedSet` / `DO UPDATE` path used for
`game` / `drive` / `play`. `loadTeamMap` / `resolveTeam` is the prior art, ported as
upsert-on-miss instead of throw-on-miss. A play whose participant id resolves to a freshly
inserted player is never blocked; loud-fail simply does not apply to players.

**3. Writer column-ownership partition** (this is what makes the split safe — two name columns,
one writer each):

| Column | Writer | Nullability | Notes |
| --- | --- | --- | --- |
| `gsis_id` | pbp (ingest) | NOT NULL | natural / join key; the upsert conflict target |
| `placeholder_name` | pbp (ingest) | NOT NULL | raw pbp name; written once via `DO NOTHING`, never touched again |
| `canonical_name` | enrichment | nullable | the **only** writer is the enrichment job |
| `position` | enrichment | nullable | enrichment-owned |
| `team` | enrichment | nullable | enrichment-owned |

Reads resolve the display name as **`canonical_name ?? placeholder_name`** — provably non-null
because `placeholder_name` is `NOT NULL`. **`canonical_name IS NULL` is the honest
"seen-but-not-yet-enriched" signal** (including players the roster asset never carries). Because
the pbp write is `DO NOTHING`, a re-ingest can never clobber an enrichment-owned column with a
dirty pbp placeholder; because enrichment is the sole writer of its columns, its cadence can lag
without ever touching the write-once fact path.

## Why

1. **Decoupling / write-once integrity (load-bearing).** Keeping identity *inside* the pbp
   freeze surface means player existence is derivable from the fact source itself, so nothing on
   the write-once fact path depends on an external source's cadence. Roster becomes a
   slowly-changing enrichment overlay. Alternative (b) does the opposite — it binds ADR-0019's
   single-freeze-surface fact ingest to the roster release's freshness, which is exactly the
   coupling ADR-0019 exists to avoid.
2. **Critical-path de-risking.** The roster/players parquet is a **new, unproven** integration
   (no repo code reads it today). This decision makes its spike non-blocking: the MVP ships on
   pbp-only identity; enrichment lands later. (b)/(c) put the unproven integration on the ship
   path.
3. **Idempotency for free.** The player upsert is conflict-tolerant on `gsis_id` — the
   ADR-0027 ensure-exists shape, no new machinery. A concurrent double-insert under parallel
   drains collapses harmlessly, same as the existing `game` / `drive` upserts.
4. **Correctness locality.** (a) never emits a fact row referencing an unresolvable player.
   (c)'s null FKs would leak referential holes into every downstream reader (Player Page, the
   opponent-rank join).

## Alternatives rejected

- **(b) Roster is the dimension, refreshed inside each ingest, loud-fail retained.** Simpler
  until the first rookie appears — then it is a production stall on the write-once path. Trades a
  rare-but-total failure for a routine on-the-fly upsert, and couples fact ingestion to an
  external refresh cadence (rejected reason 1).
- **(c) Tolerate a null player FK + async backfill.** Weakest: leaks referential holes into
  every reader and defers the resolution the slice exists to deliver (rejected reason 4).

## Open follow-ons (non-blocking — do NOT gate the MVP)

- **Null-rate sample.** Verify that "**when a role participant is present, is `gsis_id`
  populated?**" is very-low-null on attributed skill plays, sampled against the backfill's
  2021–2025 pbp (`scripts/backfill/`; `play` is empty in every DB during the offseason, so this
  cannot be measured from the live tables yet). Per-*play* nulls are high and expected (role
  structure — non-pass plays have null passer/receiver, etc.); the metric that matters is
  id-presence *given* an attributed participant. If it is **not** clean, policy (a) needs a
  null-id skip/quarantine clause — reopen this ADR if so.
- **Players-release spike (enrichment only).** Add a `playersReleaseUrl()` builder and point the
  existing generic `readReleaseParquet` (`lib/ingestion/nflverse.ts`) at the players asset;
  confirm `hyparquet` parses its schema and that `gsis_id` is the key. ADR-0013-style, and
  non-MVP-blocking by construction (the reader is already release-generic — only a URL builder is
  missing).
- **Enrichment cadence.** Full-refresh cron vs. queued `job_queue` units. The player dimension is
  small (~2–3k active players), so a plain full-refresh cron may beat per-unit jobs. Its own fork
  when enrichment is built.

## Cross-references

- **ADR-0011** — the constraint this builds on: per-game `playerGame`, denormalise-at-ingestion.
  Silent on source, so this ADR does not amend it.
- **ADR-0018** — this ADR **completes** the "adds the FK + resolves text→player_id" resolution
  that ADR-0018 deferred to Slice 4 (a dated forward-reference note is added to ADR-0018 pointing
  here).
- **ADR-0019** — write-once freeze surface: identity resolution stays inside it (rejected reason
  1 is this ADR honoring 0019).
- **ADR-0027** — the ensure-exists / idempotency-by-construction shape the player upsert reuses.
- **ADR-0009** — the compute-live-vs-store principle behind the `canonical_name ?? placeholder_name`
  read.
- **ADR-0013 / ADR-0029** — the parquet-in-Node spike + the release-generic `hyparquet` reader the
  enrichment spike extends.
- `docs/parquet-mapping.md`, `db/schema.ts` — carry the same ADR-0018 deferral statement; the
  concrete `player` / `playerGame` migration is this ADR's build-time application.
