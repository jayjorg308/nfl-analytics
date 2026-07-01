# Phase 3b discovery: completeness-state targeting, the gate-passed marker, and the active window

ADR-0027 closed Phase 3b's enqueue layer — **filter (i)** (the uniform
`pending`/`in_progress` ensure-exists guard) and the **principle** of **filter (ii)**
(discovery's "does this unit need work?" targeting keys off **data-completeness state**,
never job-`completed` status). It deliberately stopped at the discovery boundary and handed
this ADR three open questions: filter (ii)'s **mechanism** (how discovery cheaply reads
completeness per unit), the **gate-passed completeness signal** `ingest_game` likely owed,
and discovery's **orchestration shape** (active window, day→target mapping, enumeration,
enqueue). This ADR closes them.

It **builds on** ADR-0027 (the two filters and the (A)↔(B) idempotency split), ADR-0026 (the
two-tier unit of work, the schedule-as-denominator, week-reactive enqueue), ADR-0016 (cron
cadence, drain query, retry/backoff, the 15-minute stall sweep), ADR-0019 (write-once + the
per-game completeness gate whose result the marker records), and ADR-0015 (the cascade-delete
recovery whose transparency the whole design preserves). It **amends ADR-0026** in one place
(relocating its handler-runtime precondition guard — §5) and **corrects a now-inaccurate
descriptive rationale in ADR-0027** (the overlap asymmetry — §4); back-reference notes are
added to both.

## 1. The gate-passed marker: `game.playsFrozenAt`

`ingest_game` completeness is **not** checkable by output presence. Play rows can exist for a
game that **failed** its gate — a gate-fail commits partial plays (the `UNIQUE(game_id,
play_id)` upsert corrects them on a later, more-complete parquet), so **play-presence ≠
gate-passed**. `ingest_game` therefore owes an explicit completeness signal, which this ADR
fixes as **a nullable, set-once timestamp column on `game`: `playsFrozenAt`** (`null` = not
gate-passed; non-null = the game's plays passed the completeness gate and are frozen).

- **Form — column on `game`, not a separate table, status-enum value, or derived check.**
  The read is cheap and local (`WHERE season_id = S AND week IN (…) AND plays_frozen_at IS
  NOT NULL`, served by the existing `game_season_week_idx`), needs no join, and — decisively —
  **dies with the row the cascade-delete runbook removes**. The runbook's
  `Re-running Phase 3a after Phase 3b` procedure `DELETE`s the `game` row for `(2026, week >
  0)`; a column on `game` vanishes with it, re-exposing the unit to discovery from the
  schedule automatically (filter (ii) transparency, for free). A separate table would have to
  be added to that cascade `DELETE` (one more thing to remember; dangling-row risk).
- **Timestamp, not boolean.** Same one-column cost, but it also carries the **freeze-point**.
  This is the *only honest* provenance available: ADR-0019 records that nflverse **overwrites
  the rolling parquet in place**, so there is no stable upstream release id to record. The
  timestamp *is* the freeze-point write-once means ("frozen as-of this ingest"); recording a
  fabricated source-version would be recording a fiction. It stays a bare completeness +
  freeze-time marker, not a source-version provenance.
- **Set-once, idempotent write (ADR-0027 (A)).** Written as the **last step** of
  `ingest_game`, only on gate-pass: `UPDATE game SET plays_frozen_at = COALESCE(plays_frozen_
  at, now()) WHERE …`. Setting a timestamp is an idempotent SET, not a read-own-and-increment;
  `COALESCE` keeps the value stable under a stall-sweep re-run of the same row, and a
  cascade-delete gives a legitimate re-ingest a fresh freeze time because the old row is gone.
- **Not `game.status`.** `status` (`scheduled`/`in_progress`/`final`) is **real-world** game
  state — a game can be `final` (score posted) with its plays absent or present-but-incomplete,
  which is exactly the write-once hole ADR-0019 guards. The marker is *our pipeline's*
  derivation state. Keep the two orthogonal; overloading `status` would collapse the
  score-availability distinction §4 relies on.

**The marker earns its keep precisely at the asymmetry.** Because it is set only on gate-pass,
"plays committed but not yet complete" is a safe, distinguishable state: a gate-fail leaves
partial plays *and a null marker*, so filter (ii) — which reads the marker, not play-presence
— correctly still sees the game as needing work.

### The `ingest_game` sequence this implies

Discovery does **not** pre-create `game` rows (consistent with ADR-0026's "scheduled-row
preload is out of scope"). `ingest_game` owns the whole sequence: **create the `game` row**
(final score from the schedule) → **write plays/drives** → **run the completeness gate**
(score reconciliation against the row's final score + the play-count floor, ADR-0019) → on
pass, **set `playsFrozenAt` last** and mark the job `completed`. The gate reconciles against a
score the same job just wrote from the schedule, so the row must — and does — exist first.

## 2. The two completeness reads, and why their mechanisms differ

Filter (ii) is "is the output present?" on both job types — but the mechanism differs because
the two outputs differ in **self-certification**:

- **`aggregate_week` — bare existence.** `EXISTS (SELECT 1 FROM team_week_stats WHERE
  season_id = S AND week = W)` ⇒ done. Sufficient because the week's rows are written in a
  **single atomic transaction** (ADR-0027 (A) property #2), so *any* row existing implies
  *all* committed; a partial set can never be observed. The row-count expectation
  (32/14/8/4/2) is the **handler's** pre-commit post-condition assertion (ADR-0026), not
  discovery's — pushing it into discovery would (a) import a derivation discovery has no other
  reason to carry (`payload.expectedGames` is the *game* count, ~16, a different number for a
  different purpose) and (b) silently *mask* a broken-transaction bug by re-enqueuing instead
  of catching it loudly where it belongs.
- **`ingest_game` — the explicit `playsFrozenAt` marker** (§1), precisely because its output
  is *not* self-certifying: plays can exist committed-but-incomplete.

**The principle is one; the mechanisms are two because the outputs differ.** The marker exists
exactly where the output cannot certify its own completeness; bare existence works exactly
where it can.

**Coupling to pin (both directions).** The existence read is sound **only because** the
week-write is atomic. If a future refactor splits the week-write into per-row upserts outside
one transaction, a partial set becomes observable and the existence read would silently read
"done" on an incomplete week. So: discovery's `aggregate_week` completeness read notes "sound
only under ADR-0027 (A)'s atomic week-write," and (A)'s atomic-write property notes "discovery's
completeness read depends on this." Neither may be changed without the other's note surfacing
(the same discipline as ADR-0027's (A)↔(B)).

**Staleness is handled by `DELETE`, never by "row exists but is wrong."** The only way present
rows are stale is the Phase-3a-rerun cascade, whose recovery is cascade-*delete* — precisely so
the existence read re-exposes the unit. Discovery never second-guesses stored values; it reads
presence.

## 3. The active window

**Discovery's active window = the current NFL week + one prior completed week (reach-back of
one week).** The window is **season-scoped**: the reach-back floors at week 0 of the current
season and **never** reaches into the prior season's week 22.

**The binding constraint on width is retry semantics, not cost.** Filter (ii) is cheap
(indexed existence reads, zero play scans), so a wide window is affordable. What bounds it is
this: a `failed` `ingest_game` job does **not** block re-enqueue (filter (i) is
`pending`/`in_progress`-only, ADR-0027, deliberately, for cascade transparency). So any week
still inside the window with a null `playsFrozenAt` is re-minted as a fresh job each discovery
run, resetting `retryCount`. A window that is too *wide* therefore doesn't merely waste reads —
it would **silently resurrect genuinely-failed games forever**, converting ADR-0016's
"5 attempts → `failed` → human attention" into an endless quiet retry. The bound exists to let
real failures *fall out* into human attention.

**Why one week back:** it covers the realistic transient (a single cron that didn't fire, a
deploy that ate one window, parquet >31h late but arriving by next week — week N+1's discovery
re-targets it with fresh attempts), while bounding auto-retry to ~2 weeks before a broken game
falls out of the window into a standing `failed` row. A multi-week total outage is correctly a
**human event**, backstopped by the runbook's manual re-enqueue path — orphaning beyond the
window is a feature, not silent data loss.

### Pure data-state targeting — no job-status read

Discovery **must not** read job status to decide targeting. Treating `failed` as
terminal-until-human ("`failed` exists → skip") is not merely a filter-(ii) principle violation
— it actively **reintroduces cascade-staleness**: after a Phase-3a re-run, a cascade-deleted
week whose prior job had `failed` leaves a stale `failed` row in `job_queue`, and a
`failed`-aware discovery would wrongly skip re-targeting that week, defeating the
auto-re-exposure that data-state keying buys for the `completed` case. Pure data-state targeting
is the **only** mechanism that keeps cascade-transparency uniform across `completed` **and**
`failed` prior jobs.

### ADR-0016's failure model, refined (not reversed)

Under this design, "5 attempts → `failed` → human attention" is **refined**:

- **`failed` is a per-job-*lineage* terminal state, not a per-*game* one.** A game's lineage
  fails after 5 attempts; discovery mints a fresh lineage (`retryCount = 0`) on the next
  in-window run. The reset is **intentional**. The per-*game* effective cap is therefore
  ≈ 5 × (weeks in window) ≈ **10** over the two-week window, not 5.
- **Game-level terminality is delivered by the window** (the game falling out after ~2 weeks)
  **plus observability** (the Slate Dashboard's most-recent-week staleness indicator + the
  standing `failed` row), **not** by the `failed` status and **not** by discovery abstaining.
- **Auto-resurrection of slow-but-arriving data is the same mechanism as bounded retry of true
  failures:** a parquet >31h late (past the per-job backoff cap) but arriving within the next
  week self-heals automatically; a genuinely broken game retries for the same bounded span,
  then orphans. One mechanism, two outcomes.

Nothing in ADR-0016 is *reversed*, but the operative meaning of `failed` changes, so this is an
**amends-ADR-0016** relationship.

The adaptive alternative — "reach back to the earliest incomplete week, capped at K" — is the
documented escape hatch if a real >2-week-recoverable case ever appears. The fixed one-week
window + the manual runbook backstop is sufficient at v1's single-operator / friend-group
scale; cheap to widen later.

## 4. Day-agnostic, data-state targeting

**Discovery's targeting is day-agnostic. The Mon/Tue/Fri cadence (ADR-0016) is a
parquet-*availability* schedule, not a game-*partitioning* scheme.** Each run, whatever day it
fires, enumerates the active window's scheduled games and targets those that are
**(score-available) AND `playsFrozenAt IS NULL` AND have no live job (filter (i))**. The day
never partitions which games a run "owns."

This dissolves flex scheduling, the late-season Saturday slate, and international games as
edge cases: a game flexed Sunday→Monday isn't a partitioning problem, it's just "scored later,"
and discovery targets it whenever its score appears. Strict day-ownership ("Monday owns Sunday
games") would hard-code a `gameDateTime → discovery-day` map that flex actively breaks, and buy
nothing the data-state filters don't already give. ADR-0016's "Monday handles Sunday games"
language is honored as a *description of the expected effect* of cadence-vs-availability, not a
rule discovery encodes.

### Score-availability sequencing

**Discovery owns score-availability by enumeration; the handler owns plays-completeness by the
gate.** The nflverse **schedule** carries only the *final* score (null until the game
completes); the in-progress score is quarantined in the pbp parquet that discovery never reads
(`total_home_score`/`total_away_score`, per `docs/parquet-mapping.md`). So **score-presence in
the schedule == finality** by construction — the established repo convention
(`home_score.notna() & away_score.notna()`, used as the "game was played" filter throughout
`scripts/backfill/`). A "live score enqueues a game mid-play" churn risk cannot arise from a
schedule-only discovery.

Consequently the `ingest_game` handler has a **single gate** (plays-completeness), not the two
waits an earlier framing implied. A scoreless game is simply never enqueued; if one ever
reaches the handler that is a **discovery-contract breach**, so the handler **asserts the score
is present and loud-fails** rather than quietly waiting. The two distinct conditions land in two
components: discovery (score-availability, by enumeration) and the handler (plays-completeness,
by the gate).

### Edge cases — zero special-casing

- **Byes** — a bye is just fewer games in the schedule that week; the denominator counts only
  scheduled games, and bye carry-forward is `aggregate_week`'s handler concern (ADR-0026).
- **Season boundary / week 0** — at week 1 the reach-back is to week 0, which has no games to
  ingest and an `aggregate_week` Phase 3a already satisfied (`teamWeekStats(S,0)` exists →
  existence read = done). A natural no-op; the explicit season floor (§3) prevents the
  reach-back from crossing into the prior season's week 22.
- **Regular→playoff boundary and playoffs** — consecutive week numbers; week-reactive
  enumeration (ADR-0026) means discovery enqueues a playoff week's games only once the bracket
  fills and the schedule carries those matchups. The denominator (6/4/2/1) is snapshotted per
  ADR-0026.

### Discovery is schedule-only

For targeting, discovery needs only the **light schedule file** (matchups, scores, `gameType`,
dates) — not the heavy play-by-play parquet, which is the **handler's** input. This **amends
ADR-0026's line "Each cron run pulls the season parquet once"**, a leftover from an earlier
division of labor; discovery is schedule-only. The per-game pbp read strategy is a separate,
deferrable handler concern (a v1 lean: pull the season parquet, filter to `game_id` in memory;
predicate-pushdown on `game_id` is the optimization to reach for *if* the 300s budget tightens
and *if* the parquet's row-group ordering would actually let pushdown skip row groups —
unconfirmed, deferred).

## 5. The enqueue assembly, the paired invariants, and the relocated precondition

### Two matched invariants — the premise under ADR-0027's "filter (i) is the complete dedup story"

ADR-0027's claim that filter (i) is a *complete* dedup story is true **only** under two coupled
invariants this ADR owns. They are breakable from either side, so they are named together:

1. **INSERT-only-from-discovery.** A drained job that must retry (failed gate, stall sweep)
   **resets its own row** (`UPDATE … SET status = 'pending', not_before = now() + backoff,
   retry_count = retry_count + 1`); it **never** INSERTs a new row. The only INSERTers are
   **discovery** and **manual runbook ops** (cascade re-enqueue), both via the ensure-exists
   guard. Realize a handler retry as an INSERT and you silently reintroduce the accumulation
   filter (i) exists to prevent.
2. **LIVE-scoped ensure-exists.** Discovery's INSERT gates on *no `pending`/`in_progress` job
   for the key* — **never** any-row-including-`failed`. Tighten it to any-row and you silently
   break §3's failed-game re-mint.

One says "the only INSERTer is discovery"; the other says "discovery's INSERT must stay
live-scoped." Together they make ADR-0027's filter (i) airtight; the same bidirectional-coupling
discipline as ADR-0027's (A)↔(B).

### The assembly

For each week W in the window {N−1, N} (N derived from the schedule as the week bracketing
*now*, floored within the season per §3):

1. Read the **schedule** for `(season, W)` → the expected game set with scores + `gameType`.
2. **`ingest_game` targets** = scheduled games with score present, **minus** games whose
   `game` row has `playsFrozenAt IS NOT NULL` (a set-difference against one indexed read of
   frozen `nflverseGameId`s in the window — filter (ii); a `failed` game falls through to a
   fresh-lineage INSERT — filter (i) is live-scoped). For each target, ensure-exists-INSERT an
   `ingest_game` job keyed on `nflverseGameId`.
3. **`aggregate_week` target** = if `NOT EXISTS teamWeekStats(S,W)` **AND** all of W's
   scheduled games are frozen (`count(frozen games in W) == count(scheduled games in W)`,
   computed from the frozen-set read step 2 already does), ensure-exists-INSERT one
   `aggregate_week(W)` keyed on `season + week`, with `expectedGames` snapshotted = the
   scheduled-game count for W.

Cost: ≈ (≤16 ingest + 1 aggregate) × 2 weeks ≈ **~34 ensure-exists checks per run** — ADR-0027
accepted ~17/run; doubling for the window is still trivial.

### The relocated `aggregate_week` precondition — amends ADR-0026

ADR-0026 placed the `aggregate_week` precondition at **handler runtime**: drain the job, check
`COUNT(complete games) == expected`, and re-enqueue via `not_before`/backoff if unmet. That
mechanism collides with ADR-0016's 5-attempt/~31h cap, because a precondition can *legitimately*
stay unmet for >24h (`aggregate_week(N)` enqueued Monday backs off through ~Tuesday 17:00, but
week N is not complete until MNF freezes Tuesday afternoon) — so the aggregate could **fail out
before its precondition could possibly be met**.

This ADR **relocates the precondition into discovery's enqueue gate** (step 3 above): the
aggregate is enqueued *only when ready to succeed* (its whole slate, including MNF, is frozen).
There is therefore **no precondition-unmet retry**, and the cap-vs-precondition collision is
**dissolved, not managed**. Consequences:

- **Both handlers are now symmetric:** "precondition asserted → work → post-condition
  asserted," with **zero runtime waits** — all waiting lives in discovery's enumeration.
  `aggregate_week` asserts at execute that all of W's scheduled games are still frozen
  (`expectedGames` is the reference count for this assertion — its role shifts from ADR-0026's
  runtime backoff-guard denominator, but it keeps its place in the payload and its
  snapshot-at-discovery rationale, for bracket/flex stability), loud-fails on violation (a
  mid-flight cascade), computes + writes, then asserts the 32/14/8/4/2 row-count post-condition.
- **`failed aggregate_week` is now honest:** it means a genuine compute fault, not "wasn't
  ready yet" — so §3's failure model (per-lineage terminal, re-minted by discovery) is uniform
  across both job types.

**Relationship to ADR-0026 — amends, not reversal.** ADR-0026's *load-bearing* decision is the
**negative** one — "no `depends_on` column, no dependency-resolution machinery, the queue stays
a flat drain" — and that survives untouched: the enqueue gate is a single `count == count`
data-state predicate (the same shape as §2's existence read and §4's score-gate); the dependency
lives implicitly in the frozen data, not in an explicit graph. Only the **positive** mechanism
0026 specified (the runtime check + backoff) relocates. A back-reference note is added to
ADR-0026's "Precondition guard, not a dependency engine" section, because its current text would
otherwise lead a future implementer to rebuild the runtime guard this ADR removes.

**Accepted trade-off (noted, not open):** the enqueue gate widens the check-to-execute window
versus the old runtime guard's near-zero one. The handler's precondition assertion + the cascade
runbook's re-enqueue cover it; a mid-flight cascade is rare and deliberate. A fair price for
dissolving the churn and symmetrizing the handlers.

## Discovery's own idempotency / overlap-safety

Because discovery is **ensure-exists-INSERT only** (the paired invariants above), re-running it
or overlapping two runs is harmless: both compute the same target set over the same schedule +
data state, and the guard dedups. Discovery needs **no singleton lock** — the filter-(i)
mechanism does that work, doing double duty. (The rare same-instant double-fire that leaks past
the racy `WHERE NOT EXISTS` is neutralized by ADR-0027 (A), exactly as for any other enqueue.)

## `playsFrozenAt` forward-dependency

This ADR's `ingest_game` filter (ii) reads `game.playsFrozenAt`, a column added by the `0003`
migration alongside this ADR (matching the `0002` schema-ahead-of-code precedent). The
implementation session must apply `0003` before any handler code reads the marker; the
forward-dependency is explicit so no reader is surprised to find the column referenced before
its first use.

## Update 2026-06-30: "frozen" now includes per-game player facts (refined by ADR-0032)

Slice 4 folds per-game player-fact writes into `ingest_game` (ADR-0032). Those writes join a new
**post-gate transaction atomic with the `playsFrozenAt` write**, so the marker's meaning widens:

- **§1 (the marker).** `playsFrozenAt` non-null now means **plays passed the gate AND the game's
  per-game player facts (`playerGame` rows + the ADR-0031 player upserts) are materialised** — not
  plays-complete alone. The marker **mechanism** is unchanged (set-once, `COALESCE`, last write on
  gate-pass, dies with the `game` row on cascade-delete); only what a set marker *certifies* grows.
- **§5 (the enqueue precondition).** Step 3's "enqueue `aggregate_week(W)` once all of W's
  scheduled games are frozen" therefore now *also* guarantees **every `playerGame` row for W exists
  before `aggregate_week` runs**. This is a **benefit**, not a complication: the tier-2
  opponent-rank denormalisation writes *onto* `playerGame`, so the strengthened precondition is
  exactly what it needs.

The completeness **gate** itself (§1 / §4: score reconciliation + play-count floor, ADR-0019)
stays **plays-only** — player-agg is a required post-gate *write*, not a gate condition. This is a
**refined-by-ADR-0032** relationship; see ADR-0032 for the folded ordering and the measured sizing.

## Cross-references

- ADR-0027 — filters (i)/(ii) and the (A)↔(B) idempotency split; this ADR closes filter (ii)'s
  mechanism and corrects 0027's now-inaccurate overlap-asymmetry rationale (see the note there).
- ADR-0026 — the two-tier unit of work, schedule-as-denominator, week-reactive enqueue; this
  ADR amends its handler-runtime precondition guard (relocated to discovery) and its
  "pulls the season parquet once" line (discovery is schedule-only) — notes added there.
- ADR-0016 — cron cadence, drain query, retry/backoff, stall sweep; this ADR refines its
  failure model (`failed` is per-lineage, not per-game).
- ADR-0019 — write-once + the per-game completeness gate whose pass `playsFrozenAt` records;
  the freeze-point semantics the timestamp carries.
- ADR-0015 — cascade-delete recovery; the marker-on-`game` form and pure data-state targeting
  keep it transparent across `completed` and `failed` prior jobs alike.
- ADR-0032 — refines this ADR's `playsFrozenAt` / "frozen" meaning to include per-game player
  facts (see the dated update above).
