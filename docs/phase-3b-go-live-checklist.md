# Phase 3b go-live checklist (first live 2026 ingestion)

The crons are deployed and verified as a **no-op during the offseason** (discovery targets the
2026 season, whose games are all future/unscored → 0 enqueued, 0 drained). This checklist is for
the **first real ingestion weeks** (~Sept 2026 onward), when the pipeline does actual work for the
first time. It also collects the pre-registered live watch-items the implementation deferred to
production (ADR-0019 / ADR-0026 / ADR-0028).

All verification SQL below runs in the **Neon console SQL editor on the production branch** — no
`.env.local` repointing needed. Awareness sources per ADR-0016: Vercel cron logs (Observability)
+ the Slate Dashboard's most-recent-week indicator.

---

## 0. Pre-season sanity (do once, August / before Week 1)

- [ ] Vercel → Settings → **Cron Jobs**: all 4 entries still registered (1 primary + 3 drain),
      after any redeploys since 2026-06-29.
- [ ] **CRON_SECRET** still set in Vercel **Production** env (survives redeploys, but confirm).
- [ ] The 2026 Week-0 baseline — Phase 3b's input — is intact:
  ```sql
  SELECT count(*) AS teams, round(avg(elo_rating)::numeric, 1) AS mean_elo
  FROM team_week_stats t JOIN season s ON s.id = t.season_id
  WHERE s.year = 2026 AND t.week = 0;   -- expect 32 teams, mean ≈ 1500.0
  ```

---

## 1. First Monday after the first Sunday slate (the moment of truth)

The Monday primary cron (10:00 UTC) is the first run that should do real work: discover the
scored Week-1 games, enqueue `ingest_game` jobs, and drain them.

- [ ] **Vercel logs** for `/api/cron/ingest` show a 200 with **non-empty** `enqueued.ingestEnqueued`
      (the Sunday games) and `drained.completed > 0`.
- [ ] Data landed in prod:
  ```sql
  SELECT
    (SELECT count(*) FROM game g JOIN season s ON s.id=g.season_id
       WHERE s.year=2026 AND g.week=1 AND g.plays_frozen_at IS NOT NULL) AS frozen_wk1_games,
    (SELECT count(*) FROM play  p JOIN season s ON s.id=p.season_id WHERE s.year=2026 AND p.week=1) AS wk1_plays,
    (SELECT count(*) FROM drive d JOIN game g ON g.id=d.game_id JOIN season s ON s.id=g.season_id
       WHERE s.year=2026 AND g.week=1) AS wk1_drives,
    (SELECT count(*) FROM job_queue WHERE status='failed') AS failed_jobs,
    (SELECT count(*) FROM job_queue WHERE status='in_progress') AS in_progress_jobs;
  ```
  Expect: `frozen_wk1_games` = the number of *completed* Sunday games; `wk1_plays`/`wk1_drives` > 0;
  `failed_jobs` = 0; `in_progress_jobs` settling to 0 (a non-zero count >15 min old is stall-swept).
- [ ] **`aggregate_week` runs after the week completes, not Monday.** It is enqueued only once *every*
      Week-1 game is frozen — i.e. after Monday Night Football (Tuesday's cron). So `teamWeekStats(2026,1)`
      appears Tuesday, not Monday. After Tuesday:
  ```sql
  SELECT count(*) AS wk1_tws_rows   -- expect 32
  FROM team_week_stats t JOIN season s ON s.id = t.season_id
  WHERE s.year = 2026 AND t.week = 1;
  ```

---

## 2. Ship-criterion hand-verification (ADR-0012 #4 — do once, Week 1 or 2)

Prove the forward ELO chain *continues* the Phase-3a baseline on real 2026 data (the dev tests
proved the handler reproduces Phase 3a's Python to machine epsilon against 2025; this confirms it
runs correctly live). Re-derive **≥3 games** by hand.

- [ ] Pull a few teams' baseline → Week-1 ELO:
  ```sql
  SELECT t.abbreviation, w0.elo_rating AS baseline, w1.elo_rating AS wk1, w1.elo_change,
         w1.record_wins, w1.record_losses, w1.sos_rank
  FROM team t
  JOIN team_week_stats w0 ON w0.team_id=t.id AND w0.week=0
  JOIN team_week_stats w1 ON w1.team_id=t.id AND w1.week=1
  JOIN season s ON s.id=w0.season_id AND s.id=w1.season_id
  WHERE s.year=2026 AND t.abbreviation IN ('KC','BUF','PHI');
  ```
- [ ] For each: `wk1 == baseline + elo_change`, and `elo_change` is a sane single-game MOV update
      (roughly ±5 … ±40). Hand-check one against the `elo.py` / `aggregate-week.ts` formula:
      `hfa = isNeutral ? 0 : 50`; `expH = 1/(1+10^((awayElo − (homeElo+hfa))/400))`;
      `mult = ln(|margin|+1)·2.2 / (winnerEloDiff·0.001 + 2.2)`;
      `newElo = elo + 20·mult·(actual − expected)`.
- [ ] `record` matches the games actually played (1-0 / 0-1 / 0-0-1); `sos_rank` ∈ 1…32.
- [ ] EPA sanity: `offensive_epa_per_play` for the week sits in a plausible band (≈ −0.4 … +0.4).

---

## 3. Completeness-gate tuning (ADR-0019 — first live week)

- [ ] No **legit complete game** falsely failed the gate. A `failed` `ingest_game` job whose game
      *is* actually complete means a threshold needs attention:
  - **Play-count floor** (`PLAY_COUNT_FLOOR = 100`, `lib/ingestion/ingest-game.ts`) — if a real
    complete game has fewer plays than the floor, lower it. This is the **tunable** knob.
  - **Score reconciliation** — `SCORE_RECONCILIATION_TOLERANCE` **stays 0**. If a complete game
    fails reconciliation, it's either genuinely missing plays (let the retry/window handle it) or a
    scoring type not in `sumScoringPoints` attribution (e.g. a 1-point conversion safety) — **extend
    the attribution**, never widen the tolerance (a tolerance ≥1 would mask a missing extra point).

---

## 4. First 2026 postseason (Jan 2027) — the week-19 bye-derivation timing check

The one piece validated only against *complete* 2025 data, not live. The wild-card-week (`week 19`)
#1-seed byes are derived as the **divisional (week 20) slate minus the wild-card participants**, read
from the nflverse schedule. This requires the divisional matchups to be **published by the time
`aggregate_week(2026,19)` runs** (after all wild-card games freeze).

- [ ] After wild-card weekend, confirm `aggregate_week(2026,19)` **completes** and writes **14 rows**
      including the **2 byes** (eloChange 0, week-18 frozen rates):
  ```sql
  SELECT count(*) AS wk19_rows,
         count(*) FILTER (WHERE elo_change = 0) AS byes   -- expect 14 rows, 2 byes
  FROM team_week_stats t JOIN season s ON s.id=t.season_id
  WHERE s.year=2026 AND t.week=19;
  ```
- [ ] **Failure mode is loud, not silent:** if the divisional slate isn't published in time, the bye
      set is wrong → the 14-row assertion fails → the job throws and retries (it does *not* write a
      bad week). Watch for an `aggregate_week` for (2026,19) cycling on retries / landing in `failed`.
      Mitigation if it happens: it self-heals once the schedule publishes (discovery re-mints within
      the window); a persistent failure means falling back to a bracket/pbp-derived slate (ADR-0026
      pre-registered fallback) — surface it, don't tune around it.

---

## 5. Optional — ADR-0019 write-once forward validation (research-grade, first weeks)

Measure (rather than assert) the fidelity cost of freezing at first-complete-release:

- [ ] Archive a provisional Monday pbp parquet for a week; re-pull the same week ~2 weeks later;
      diff the **cumulative season-to-date** team EPA/play. Delta `< ~0.01 EPA/play` confirms the
      write-once timing; a large delta reopens *timing only* (ADR-0019), not settle-window.

---

## 6. Slice 4 first-live verifications (once player ingestion ships)

These land when Slice 4 is built and running live (player ingestion also goes live for the 2026
season). Both are first-live-2026 checks that cannot be done in the offseason (`play` / `playerGame`
are empty until Week 1).

- [ ] **`defenseRank*` external hand-verification (ADR-0033 / ship-criterion #4).** `defenseRankPass`
      / `defenseRankRush` on `team_week_stats` sort **ASCENDING** (lowest defensive-EPA-allowed =
      rank 1 = best defense — the *opposite* of `sosRank`, because the def-EPA columns are stored
      offense-perspective). A same-code test proves consistency, not correctness, and the inversion
      would pass one silently. So confirm against an **external known-good**: take a defense
      independently known to be elite (or terrible) in some week and verify its rank lands at the
      right end.
  ```sql
  SELECT t.abbreviation, w.defensive_pass_epa_per_play, w.defense_rank_pass,
         w.defensive_rush_epa_per_play, w.defense_rank_rush
  FROM team_week_stats w JOIN team t ON t.id = w.team_id JOIN season s ON s.id = w.season_id
  WHERE s.year = 2026 AND w.week = <a settled week>
  ORDER BY w.defense_rank_pass;   -- rank 1 row must have the LOWEST defensive_pass_epa_per_play
  ```
- [ ] **`ingest_game` live wall-time (ADR-0032).** The folded player aggregation was sized against a
      2022-24 hyparquet proxy (~2s heaviest-game, ~100x under the 300s ceiling). Confirm the live
      2026 number: a Week-1/2 `ingest_game` run stays comfortably sub-300s with player facts folded
      in. Vercel function logs for `/api/cron/{ingest,drain}` show per-invocation duration; a single
      game nowhere near 300s confirms the proxy held.

## Failure playbook (quick reference)

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `job_queue` row `failed` | gate fail (plays still missing past ~31h), or a real upstream gap | check Vercel log for the error; within the active window discovery re-mints a fresh lineage automatically (ADR-0028 §3) |
| `ingest_game` loud-fails on "Unknown team abbreviation" | a team relocation/rebrand nflverse now emits | add the abbreviation to `data/teams.ts` **and** the `team` table, then re-run |
| job stuck `in_progress` | crashed handler / function timeout | stall sweep auto-resets to pending after 15 min (no action) |
| a week needs reprocessing | methodology fix / cascade | runbook "Re-running Phase 3a after Phase 3b is active" (cascade-delete + re-enqueue) |
| crons silently doing nothing in-season | CRON_SECRET drift (401) or discovery targeting wrong season | hit a route manually with the bearer; confirm `enqueued.seasonYear == 2026` |

## Housekeeping

- [ ] Delete the `pre-phase3b-migrate-2026-06-29` Neon backup branch once the migration is settled
      (already verified — anytime; runbook principle #1).
