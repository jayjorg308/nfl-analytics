# Admin manual-override UI: amendment to ADR-0003

This ADR amends ADR-0003's literal rule that *"every table that has automated ingestion must also be writeable from a small admin UI behind auth."* The principle behind the rule is preserved unchanged — automated ingestion needs a documented fallback path. The amendment clarifies the implementation: **the fallback need not be a UI in every case**.

ADR-0003's framing identifies the actual driver: manual override is *"especially load-bearing for injury reports"* because nflverse's `load_injuries()` is unreliable. The UI exists because the source data is messy. Tables whose source ingestion is deterministic and high-fidelity — team stats derived from nflfastR play-by-play, EPA computations, ELO derivations — have low correction rates and don't justify the UI's maintenance cost during slices that don't introduce them.

## Classification by source error rate

Tables with automated ingestion are classified by **the error rate of the source**, not by category of table or computation. Importantly, this is about source quality, not computation quality: nflverse play-by-play is high-quality, derivations from it are deterministic, so all play-derived tables fall in the low-error-rate class. Injuries are high-error-rate because the source itself is messy, regardless of how the downstream computation works.

**High-error-rate ingestion (admin UI required):**
- `playerInjury`, `playerInjuryStatus` — nflverse `load_injuries()` unreliability documented in ADR-0003
- Weather overrides on outdoor games — Open-Meteo forecast vs game-time actuals (per ADR-0003)
- Manual prop entries — fallback for The Odds API gaps

**Low-error-rate ingestion (SQL fallback acceptable):**
- `game`, `teamWeekStats`, `play`, `drive`, `playerGame` — derived from nflverse play-by-play
- `playerSeasonStats` — rollup of `playerGame`
- `gameOdds`, `gameOddsSnapshot`, `propLineSnapshot` — direct from The Odds API, structured

For low-error-rate tables, **direct SQL via Neon console is the documented fallback**. `docs/runbook.md` covers the specific procedures (correcting a game outcome with downstream ELO recompute, correcting `teamWeekStats` values with downstream-impact notes, re-running Phase 3a after Phase 3b is active).

## Admin UI bundles with the slice that needs it

When admin UI *is* required, it lands in the slice that introduces the high-error-rate ingestion — not as a standalone admin slice. For injuries specifically, this is the Player Page slice (which introduces injury ingestion alongside player-game data and the views that surface injury status). Bundling tightens the feedback loop between feature work and the correction surface it depends on; the developer building injury ingestion is the one most likely to know what the correction UI needs to look like.

## Why not build admin UI for Slice 3 tables anyway

Three reasons. First, low-error-rate ingestion's correction surface is narrow — `teamWeekStats` has 12 mostly-numeric columns; manual entry is well-served by SQL. Second, the developer is the audience during Slice 3, with full SQL fluency and Neon's query history as a safety net; the audience for which a UI would be valuable (the friend group, non-developer collaborators) doesn't touch corrections. Third, building per-table forms now means committing to UI shape (form layout, validation, edit-vs-create flow, audit trail) before knowing what corrections actually feel like in practice. The first *real* admin use case (injury status workflows: `out` → `questionable` → `activated`) will inform the right shape; building team-stats UI first means shipping the wrong shape and rebuilding later.

The Clerk three-tier auth (ADR-0005) is unchanged — admin tier already exists and is wired through middleware. Deferring admin UI doesn't undo any auth work; the route surface stays minimal until the next slice needs it.

## Future classification: operational criteria

New tables with automated ingestion get classified at the time the ingestion lands. The operational criteria:

**Low-error-rate** if the source is:
- Structured (parquet, JSON API with schema)
- Machine-generated (no human judgment in the source pipeline)
- Historically reliable (community-vetted, low rate of post-release corrections)

**High-error-rate** if the source involves:
- Human judgment (injury status determinations, manual prop entries)
- Manual entry (typed by humans at any stage of the pipeline)
- Historical correction patterns (the source publishes corrections to past values with non-trivial frequency)

**When ambiguous**, default to low-error-rate with SQL fallback. Promote to high-error-rate if real correction patterns emerge — i.e., if the operator finds themselves running corrective SQL more than a couple of times for the same table, that's the signal to add admin UI.

The amendment preserves ADR-0003's principle without forcing premature UI commitment. Reclassification (low → high) is expected; classification is not a permanent choice.
