/**
 * Verifies the seed produced realistic-looking dashboard data.
 * Run after npm run db:seed to confirm the Slice 1 success criterion:
 * week_summary returns Week 2 cards with non-trivial edge variation.
 *
 * Usage: node scripts/verify-seed.mjs
 */

import { config } from "dotenv";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

config({ path: ".env.local" });
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const counts = await pool.query(
    "SELECT week, COUNT(*) AS n FROM week_summary GROUP BY week ORDER BY week",
  );
  console.log("Row counts by week:");
  for (const r of counts.rows) console.log(`  week ${r.week}: ${r.n}`);

  const sample = await pool.query(`
    SELECT
      away_team_abbreviation || ' @ ' || home_team_abbreviation AS matchup,
      ROUND(home_pass_edge::numeric, 3) AS home_pass,
      ROUND(home_rush_edge::numeric, 3) AS home_rush,
      ROUND(away_pass_edge::numeric, 3) AS away_pass,
      ROUND(away_rush_edge::numeric, 3) AS away_rush,
      top_edge_label,
      ROUND(top_edge_value::numeric, 3) AS top_value,
      ROUND(top_edge_magnitude::numeric, 3) AS top_magnitude
    FROM week_summary
    WHERE week = 2
    ORDER BY top_edge_magnitude DESC
  `);

  console.log("\nWeek 2 cards (sorted by top_edge_magnitude DESC):");
  for (const r of sample.rows) {
    console.log(
      `  ${r.matchup.padEnd(12)} | edges H_pass=${String(r.home_pass).padStart(6)} H_rush=${String(r.home_rush).padStart(6)} A_pass=${String(r.away_pass).padStart(6)} A_rush=${String(r.away_rush).padStart(6)} | top=${r.top_edge_label.padEnd(9)} ${String(r.top_value).padStart(6)} (|${r.top_magnitude}|)`,
    );
  }

  const labelDist = await pool.query(`
    SELECT top_edge_label, COUNT(*) AS n
    FROM week_summary WHERE week = 2
    GROUP BY top_edge_label ORDER BY n DESC
  `);
  console.log("\nTop edge label distribution (Week 2):");
  for (const r of labelDist.rows) console.log(`  ${r.top_edge_label}: ${r.n}`);
} finally {
  await pool.end();
}
