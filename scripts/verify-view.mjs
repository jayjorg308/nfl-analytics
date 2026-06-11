/**
 * One-off check that week_summary view is queryable and has the expected
 * column shape. Run after applying the view migration.
 *
 * Usage: node scripts/verify-view.mjs
 */

import { config } from "dotenv";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

config({ path: ".env.local" });
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const views = await pool.query(
    "SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname",
  );
  console.log("Views  :", views.rows.map((r) => r.viewname).join(", ") || "(none)");

  const cols = await pool.query(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'week_summary' ORDER BY ordinal_position",
  );
  console.log(`week_summary columns: ${cols.rows.length}`);
  console.log("  First 5:", cols.rows.slice(0, 5).map((r) => `${r.column_name} (${r.data_type})`).join(", "));
  console.log("  Last 3 :", cols.rows.slice(-3).map((r) => `${r.column_name} (${r.data_type})`).join(", "));

  const count = await pool.query('SELECT COUNT(*) AS n FROM week_summary');
  console.log(`week_summary row count: ${count.rows[0].n} (expected 0 until seed runs)`);
} finally {
  await pool.end();
}
