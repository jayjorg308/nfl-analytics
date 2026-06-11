/**
 * Verifies the live Neon database shape matches expectations.
 * Run after migrations to confirm tables, enums, and indexes are present.
 *
 * Usage: node scripts/verify-schema.mjs
 *
 * Reads DATABASE_URL from .env.local. Connects to whichever branch
 * that URL points at (typically the dev branch during development).
 * Run against prod by setting DATABASE_URL inline:
 *   DATABASE_URL=<prod-url> node scripts/verify-schema.mjs
 */

import { config } from "dotenv";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

config({ path: ".env.local" });
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  const types = await pool.query(
    "SELECT typname FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace ORDER BY typname",
  );
  const indexes = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
  );
  console.log("Tables :", tables.rows.map((r) => r.table_name).join(", "));
  console.log("Enums  :", types.rows.map((r) => r.typname).join(", "));
  console.log("Indexes:", indexes.rows.map((r) => r.indexname).join(", "));
} finally {
  await pool.end();
}
