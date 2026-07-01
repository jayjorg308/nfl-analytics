# Opponent-defense-rank: computation home on `teamWeekStats`, read by opponent-N−1 join

Slice 4's Player Page shows, on a player's week-N row, the **defensive rank of the opponent that
player faced** — the "how tough was this matchup" context. The **product premise (author call,
locked): the rank is _entering_ the matchup** — it reflects the opponent's defense **through week
N−1 finalized**, never after/week N. This ADR decides **where that rank is computed** and **how a
`playerGame` row presents "entering."**

It **resolves ADR-0032's deferral** ("opponent-rank placement → fork iii") and **overturns a
prior, un-ADR'd assumption** in `docs/runbook.md` that the rank is snapshotted onto `playerGame`
at ingestion (that text also **mis-cited ADR-0011**, which defines only the share / `seasonToDate*`
fields — not this one; corrected here, §Runbook).

## Decision

**The rank lives on `teamWeekStats`, computed in `aggregate_week`, and `playerGame` reads
"entering" by joining the opponent's week-(N−1) row.** No per-player snapshot; no
window-function-on-read.

- **Two nullable columns on `teamWeekStats`: `defenseRankPass`, `defenseRankRush`.** Computed in
  `aggregate_week` (`lib/ingestion/aggregate-week.ts`) as a cross-team rank over the 32 teams'
  defensive metric — the **exact `sosRank` pattern/grain/tier**: dense positional `1..N`,
  tie-break abbreviation ascending, written in the single-transaction `teamWeekStats` upsert
  (`buildExcludedSet` auto-includes new columns).
- **The rank is a property of `(opponent_team, week)`, not of a player.** Many week-N `playerGame`
  rows share one opponent and one rank, so it is computed **once per team-week** (tier-2, where
  cross-team ranking already lives — the reason `sosRank` is there), not redundantly per player.
- **`playerGame` carries NO opponent-rank column.** The Player Page resolves "entering" by joining
  the opponent team's **week-(N−1)** `teamWeekStats` row: `playerGame → game` (identifies the two
  teams; the opponent is the one that is not the player's game-team — read from `playerGame.teamId`,
  a required Slice-4 column per §Build-time obligations) `→ teamWeekStats(opponent, season, week−1)`. An equality join to a precomputed rank on a 32-row-per-week table indexed on
  `(team, week)`; the Player Page renders ≤17 rows. Not a "just-slow" case — materialising it per
  player buys no read speed worth the redundancy or the stale-on-edit burden.

## Metric — EPA/play allowed, Pass/Rush split (author call, locked)

`defenseRankPass` ranks by **`defensivePassEpaPerPlay`**; `defenseRankRush` by
**`defensiveRushEpaPerPlay`** (both already on `teamWeekStats`). EPA/play allowed is **on-brand
with the EPA-first edge** (ADR-0002) — the same currency as everything else on the page. The
**yards-allowed alternative** (`passYardsAllowedPerGame` / `rushYardsAllowedPerGame`) is
**rejected**: more familiar, but it can visibly contradict the EPA edge sitting beside it. Pass/Rush
is the matchup-relevant split (a receiver's row shows the opponent's pass-defense rank; a rusher's,
the rush-defense rank).

## Sort direction — ASCENDING (the one silent-failure risk)

**`defenseRank*` sorts ASCENDING: lowest `defensive*EpaPerPlay` = rank 1 = best defense.** This is
the **opposite** of `sosRank`, which sorts **descending**. The reason: the defensive-EPA columns
are stored **offense-perspective, with no sign flip** (`aggregate-week.ts:350` — "defensive sign is
offense-perspective (no flip)"; `overallEpa = (off − def)/2`), so a **good** defense has a
**low/negative** value (it allowed little offensive EPA). Mirror `sosRank`'s grain, tie-break
(abbreviation ascending), positional-`1..N` dense write, and single-transaction upsert — **but
invert the comparator.**

Copying `sosRank`'s descending comparator verbatim inverts **every** defense rank, and a
same-code test would pass it silently (it proves consistency, not correctness). Therefore:

- **The direction is stated in a code comment** at the `defenseRank*` computation, not only here
  (build-time obligation, below).
- **Hand-verification is required (ship-criterion #4 discipline, ADR-0012):** confirm `defenseRank*`
  against an **external known-good** — a defense independently known to be elite (or terrible) in
  some week must land at the right end of the rank. Recorded on
  `docs/phase-3b-go-live-checklist.md` alongside the ELO/edges hand-verify.

## Nullability and the week-1 policy (author call, locked)

**`defenseRank*` is NULLABLE** (unlike `NOT NULL` `sosRank`). Week-0 rows are the Phase-3a ELO
baseline — no `aggregate_week` ran, so no defensive rank exists there. A **week-1** player row,
reading "entering through week 0," therefore joins a row whose `defenseRank*` is **NULL** — so the
**week-1 = NULL** policy is the **structural default, not a fabrication** (the alternative — deriving
a rank from week-0 ELO — is rejected: ELO is the wrong metric, and structurally it is simply NULL).
The UI shows a week-1 qualifier; weeks 2–4 return a real but thin-sample rank with a games-played
qualifier (display concern, not schema).

## Playoff freeze

`defenseRank*` **joins the week-18 rate freeze** (`frozenRatesFromWeek18`, `aggregate-week.ts`): in
playoff weeks (ragged 14/8/4/2, rates frozen at week 18 per ADR-0021), a week-19+ "entering" rank
reads the opponent's **frozen week-18** defensive rank — the sensible pick-prep value. `defenseRank*`
is added to both the `Rates` type and `frozenRatesFromWeek18`.

## Why C, over the runbook's snapshot (A) and window-on-read (B)

1. **Right grain + existing pattern.** The rank is a `(team, week)` property; computing it once in
   `aggregate_week` is the `sosRank` tier and pattern already in the handler. A stores a per-team-week
   value redundantly on every per-player row.
2. **Honors ADR-0011's window-is-bug-prone concern _without_ denormalising onto `playerGame`.** The
   ranking window runs **once at write time** (like `sosRank`), so the read is a trivial equality
   join — neither B's window-on-read nor A's redundant snapshot.
3. **"Entering" is free and the timing constraint relaxes.** The opponent's week-(N−1) row is
   immutable; the N−1 join _is_ the entering semantics, needing only that N−1 is present at **read**
   time (a prior week — always true). A additionally needs it at **ingest** time.
4. **No stale-on-edit blast radius.** A `teamWeekStats` correction re-ranks on recompute and the
   join reads current-frozen truth, so corrections **propagate automatically** — C **dissolves** the
   recalc-cascade burden A carried (the runbook text this ADR overturns).

## Runbook correction (part of this fork)

`docs/runbook.md`'s "Correcting `team_week_stats` values" (lines 40, 47) is rewritten: the
pre-assumed "materialised on `playerGame` / snapshot at ingestion / separate cascade" is replaced
with C's read-join description (correction-propagation is automatic under C), and the **ADR-0011
mis-citation is fixed** — this field is defined **here in ADR-0033**, not ADR-0011.

## ADR-0032 relationship

ADR-0032's "opponent-rank deferred to fork (iii)" **resolves as: not a tier-1 ingest write at
all** — a tier-2 `teamWeekStats` column plus a read-time join. No edit to ADR-0032; the resolution
is recorded here.

## Build-time obligations (Slice 4)

- **Migration:** add `defenseRankPass` / `defenseRankRush` (nullable integer) to `teamWeekStats`.
- **`aggregate-week.ts`:** add the two ranks to the `Rates` type, compute them in `recomputeRates`
  (ASCENDING comparator — the direction is a **REQUIRED code comment** at the computation, not
  advisory: it is the silent-failure spot §Sort-direction describes), and freeze them in
  `frozenRatesFromWeek18`. Week-0 baseline rows keep them NULL.
- **Hand-verification** on `docs/phase-3b-go-live-checklist.md` (external known-good, above).
- **`playerGame` MUST carry the player's game-team FK (`teamId`)** — this is a **required column on
  the Slice-4 `playerGame` migration**, not merely assumed. The opponent-N−1 read join
  (`playerGame → game → teamWeekStats(opponent, week−1)`) identifies the opponent as "the game's
  other team," which is only derivable if the row records *which* of the game's two teams the player
  played for. That identifier is free at fold time: it is `play.posteamTeamId` of the plays the
  player participated in (a player appears for exactly one team in a game). Without it the join
  cannot resolve the opponent.

## Cross-references

- **ADR-0026** — the two-tier unit of work + the `sosRank` cross-team-ranking tier/pattern this
  mirrors (direction inverted).
- **ADR-0011** — the window-on-read-is-bug-prone concern, honored (rank window runs once at write,
  not on read); this field is **not** among the share / `seasonToDate*` fields 0011 defines (the
  runbook mis-citation corrected here).
- **ADR-0002** — the EPA-first edge that makes EPA/play-allowed the on-brand metric.
- **ADR-0021** — bye carry-forward → a full 32 teams every regular week (so the rank is over 32 and
  the opponent's N−1 row always exists) + the playoff week-18 rate freeze `defenseRank*` joins.
- **ADR-0032** — resolves its opponent-rank deferral (not a tier-1 fold; a tier-2 column + join).
- `docs/runbook.md` — the `team_week_stats`-correction procedure rewritten under C.
- `docs/phase-3b-go-live-checklist.md` — carries the `defenseRank*` external hand-verification.
