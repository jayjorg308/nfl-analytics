# v1 derived-metric storage decisions

Applying ADR-0009's wrong-shape-vs-just-slow principle to the specific derived metrics required by v1 views.

**Computed live** — just-slow at worst, never wrong-shape:
- **Win/loss streak** — Slate Dashboard card header only. ~13 cards × one indexed scan over `game(teamId, gameDateTime)` per page render, sub-10ms each. Storing it would require cascading writes across all teams on every game ingestion, in exchange for trivial read savings.
- **Rest situation** — Game Detail Page context only. Single self-join on `game` ordered DESC by date, scoped to the matchup's two teams. Returns null for the season's first game; the UI interprets a rest value > 10 days as a bye-week indicator (10 days is the cut-off because a short week is 4–6 days, a normal week is 7, a bye is always 14+).
- **Hit margin** — Player Page props history table only. `actualValue − lineAtKickoff`, signed. Free at read time.

**Denormalised onto `playerGame` at ingestion** — used in multiple views and split queries, non-trivial team-total computation, recomputing per query would fail wrong-shape:
- `targetShare` (decimal 0–1) — receiver targets ÷ team total targets in game.
- `rushAttemptShare` (decimal 0–1) — player rush attempts ÷ team total rush attempts in game. Computed against full team rushing volume (including wildcat WR carries) for consistency with `targetShare`. "RB-share-of-RB-attempts" is a v2 refinement.
- `airYardsShare` (decimal 0–1) — receiver's air yards on targets ÷ team total air yards on pass plays in game. Distinguishes high-target short-area receivers from high-impact downfield receivers; loads naturally from nflverse play-by-play.

**Materialised running totals on `playerGame` at ingestion** — window functions on read are bug-prone (off-by-one, inactive-game handling, ordering), and one-shot computation at ingestion is cleaner:
- `seasonToDatePassYards`, `seasonToDateRushYards`, `seasonToDateRecYards` — running totals across the player's prior games in the same season, computed for each `playerGame` row as it's inserted. Surfaced on the Player Page game log and props history table. **Maintenance note**: if a historical game's stats are edited via the manual-override admin path (ADR-0003), the season-to-date columns for all subsequent games in that season must be recalculated — a documented admin operation, not a routine concern.

**Explicitly not added** — duplicates existing storage or is cheap enough live:
- Player season-to-date averages → already in `playerSeasonStats`.
- Team season-to-date EPA → already in `teamWeekStats` (each week's row is season-to-date through that week).
- Streak as a stored column → cross-team cascading writes on every ingestion exceed the cost of 13 live queries per dashboard render.
- Days since last game as a stored column → same reasoning as streak.
