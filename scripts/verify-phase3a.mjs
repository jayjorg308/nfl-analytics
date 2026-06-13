/**
 * Phase 3a verification — the five validation queries (ADR-0015) plus a
 * game-table type spot-check (the half the dev-run numeric spot-check left
 * implied: timestamptz / boolean / enum round-trip, where psycopg adaptation
 * quirks would hide).
 *
 * Branch-agnostic and DIFFABLE. Reads DATABASE_URL from .env.local, so it runs
 * against whichever branch that points at, and its output is deterministic
 * (sorted by year/abbreviation, rounded, no branch-specific surrogate IDs).
 * Chunk 6's prod-run safety check is therefore a literal diff against the
 * known-good dev output:
 *
 *   DATABASE_URL=<dev>  node scripts/verify-phase3a.mjs > /tmp/dev.txt
 *   DATABASE_URL=<prod> node scripts/verify-phase3a.mjs > /tmp/prod.txt
 *   diff /tmp/dev.txt /tmp/prod.txt        # empty => prod matches dev exactly
 *
 * Usage: node scripts/verify-phase3a.mjs
 */

import { config } from "dotenv";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

config({ path: ".env.local", quiet: true }); // quiet: keep stdout clean for dev-vs-prod diff
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

try {
  console.log("=== Phase 3a verification (branch via DATABASE_URL) ===");

  // [1] Row counts + ragged shape -----------------------------------------
  console.log("\n[1] ROW COUNTS");
  const c = (await pool.query(`
    SELECT (SELECT count(*) FROM season) seasons,
           (SELECT count(*) FROM game) games,
           (SELECT count(*) FROM team_week_stats) tws,
           (SELECT count(*) FROM team_week_stats WHERE week = 0) wk0,
           (SELECT count(*) FROM team_week_stats WHERE week >= 19) playoff`)).rows[0];
  check("season = 6", Number(c.seasons) === 6, `got ${c.seasons}`);
  check("team_week_stats = 3212", Number(c.tws) === 3212, `got ${c.tws}`);
  check("week-0 rows = 192", Number(c.wk0) === 192, `got ${c.wk0}`);
  check("playoff rows = 140", Number(c.playoff) === 140, `got ${c.playoff}`);
  console.log(`  game rows = ${c.games} (data-dependent; 1424 with the cancelled 2022 BUF-CIN game)`);

  const shape = (await pool.query(`
    SELECT s.year, tws.week, count(*) n
    FROM team_week_stats tws JOIN season s ON s.id = tws.season_id
    WHERE tws.week IN (0,1,18,19,20,21,22)
    GROUP BY s.year, tws.week ORDER BY s.year, tws.week`)).rows;
  const byYear = {};
  for (const r of shape) (byYear[r.year] ??= {})[r.week] = Number(r.n);
  console.log("  ragged shape (wk 0/1/18/19/20/21/22):");
  for (const year of Object.keys(byYear).sort()) {
    const w = byYear[year];
    console.log(`    ${year}: ${[0, 1, 18, 19, 20, 21, 22].map((k) => `${k}=${w[k] ?? 0}`).join(" ")}`);
  }
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const w = byYear[year] || {};
    const ok = w[0] === 32 && w[1] === 32 && w[18] === 32 && w[19] === 14 && w[20] === 8 && w[21] === 4 && w[22] === 2;
    check(`${year} ragged shape 32/32/32/14/8/4/2`, ok);
  }
  check("2026 wk0 = 32 and no later weeks", byYear[2026]?.[0] === 32 && !byYear[2026]?.[1]);

  // [2] 2026 Week-0 baseline distribution ---------------------------------
  console.log("\n[2] 2026 WEEK-0 BASELINE");
  const agg = (await pool.query(`
    SELECT count(*) n, ROUND(avg(elo_rating)::numeric, 1) mean,
           ROUND(min(elo_rating)::numeric, 1) lo, ROUND(max(elo_rating)::numeric, 1) hi
    FROM team_week_stats tws JOIN season s ON s.id = tws.season_id
    WHERE s.year = 2026 AND tws.week = 0`)).rows[0];
  check("2026 baseline = 32 teams", Number(agg.n) === 32, `got ${agg.n}`);
  check("2026 baseline mean = 1500.0 (conserved total)", Math.abs(Number(agg.mean) - 1500) < 0.1, `got ${agg.mean}`);
  console.log(`  range [${agg.lo}, ${agg.hi}]`);
  const base = (await pool.query(`
    SELECT t.abbreviation a, ROUND(tws.elo_rating::numeric, 1) elo, tws.sos_rank sos
    FROM team_week_stats tws JOIN team t ON t.id = tws.team_id JOIN season s ON s.id = tws.season_id
    WHERE s.year = 2026 AND tws.week = 0 ORDER BY t.abbreviation`)).rows;
  console.log("  all 32 sorted by abbr (the diffable baseline):");
  for (const r of base) console.log(`    ${r.a.padEnd(3)} elo=${String(r.elo).padStart(7)} sos=${r.sos}`);

  // [3] One team's 5-season trajectory ------------------------------------
  console.log("\n[3] KC 5-SEASON TRAJECTORY (wk0 + season-end ELO)");
  const wk0 = (await pool.query(`
    SELECT s.year, ROUND(tws.elo_rating::numeric, 1) elo
    FROM team_week_stats tws JOIN team t ON t.id = tws.team_id JOIN season s ON s.id = tws.season_id
    WHERE t.abbreviation = 'KC' AND tws.week = 0 ORDER BY s.year`)).rows;
  const endr = (await pool.query(`
    SELECT DISTINCT ON (s.year) s.year, ROUND(tws.elo_rating::numeric, 1) elo
    FROM team_week_stats tws JOIN team t ON t.id = tws.team_id JOIN season s ON s.id = tws.season_id
    WHERE t.abbreviation = 'KC' ORDER BY s.year, tws.week DESC`)).rows;
  const endMap = Object.fromEntries(endr.map((r) => [r.year, r.elo]));
  for (const r of wk0) console.log(`    ${r.year}: wk0=${String(r.elo).padStart(7)}  season-end=${String(endMap[r.year]).padStart(7)}`);

  // [4] Orphan check ------------------------------------------------------
  console.log("\n[4] ORPHAN CHECK (FK integrity)");
  const o = (await pool.query(`
    SELECT (SELECT count(*) FROM team_week_stats x LEFT JOIN season s ON s.id = x.season_id WHERE s.id IS NULL) tws_s,
           (SELECT count(*) FROM team_week_stats x LEFT JOIN team t ON t.id = x.team_id WHERE t.id IS NULL) tws_t,
           (SELECT count(*) FROM game x LEFT JOIN season s ON s.id = x.season_id WHERE s.id IS NULL) g_s,
           (SELECT count(*) FROM game x LEFT JOIN team t ON t.id = x.home_team_id WHERE t.id IS NULL) g_h,
           (SELECT count(*) FROM game x LEFT JOIN team t ON t.id = x.away_team_id WHERE t.id IS NULL) g_a`)).rows[0];
  check("no orphans", [o.tws_s, o.tws_t, o.g_s, o.g_h, o.g_a].every((v) => Number(v) === 0),
    `tws->season ${o.tws_s}, tws->team ${o.tws_t}, game->season ${o.g_s}, game->home ${o.g_h}, game->away ${o.g_a}`);

  // [5] Game-table TYPE spot-check (timestamptz / bool / enum round-trip) --
  console.log("\n[5] GAME-TABLE TYPE SPOT-CHECK");
  async function spot(label, where, expect) {
    const r = (await pool.query(`
      SELECT g.nflverse_game_id id, g.game_type gt, g.game_date_time dt,
             g.is_neutral_site neutral, g.is_international intl,
             at.abbreviation away, ht.abbreviation home, g.home_score hs, g.away_score asc_
      FROM game g JOIN team ht ON ht.id = g.home_team_id JOIN team at ON at.id = g.away_team_id
      WHERE ${where} ORDER BY g.nflverse_game_id LIMIT 1`)).rows[0];
    if (!r) return check(`${label} present`, false);
    const typesOk = r.dt instanceof Date && typeof r.neutral === "boolean" &&
      typeof r.intl === "boolean" && typeof r.gt === "string";
    const gtOk = expect.gt === null
      ? ["wildcard", "divisional", "conference"].includes(r.gt) : r.gt === expect.gt;
    const valsOk = gtOk && r.neutral === expect.neutral && r.intl === expect.intl;
    console.log(`  [${label}] ${r.id}: ${r.away}@${r.home} ${r.asc_}-${r.hs}  dt=${r.dt.toISOString()}  type=${r.gt} neutral=${r.neutral} intl=${r.intl}`);
    check(`${label}: types are Date/bool/bool/enum`, typesOk);
    check(`${label}: values`, valsOk, `expected gt=${expect.gt ?? "playoff"} neutral=${expect.neutral} intl=${expect.intl}`);
  }
  await spot("super-bowl/neutral", "g.game_type = 'super_bowl'", { gt: "super_bowl", neutral: true, intl: false });
  await spot("international", "g.is_international", { gt: "regular", neutral: true, intl: true });
  await spot("playoff/non-neutral", "g.game_type IN ('wildcard','divisional','conference') AND NOT g.is_neutral_site", { gt: null, neutral: false, intl: false });
  await spot("regular/non-neutral", "g.game_type = 'regular' AND NOT g.is_neutral_site", { gt: "regular", neutral: false, intl: false });

  // [6] Hand-verification reminder (ADR-0012 #4) --------------------------
  console.log("\n[6] HAND-VERIFICATION REMINDER (ADR-0012 #4 — not automatable)");
  console.log("  Hand-verify >=3 games' MOV-ELO against the formula. Per the ADR-0014 rulings, GROW");
  console.log("  the set to include +1 tie game (mult=1) and +1 non-neutral playoff game (K=20 +");
  console.log("  HFA=50) — the cold-start/mid-chain/neutral-SB trio does not cover those cases.");

  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
  if (fail) process.exitCode = 1;
} finally {
  await pool.end();
}
