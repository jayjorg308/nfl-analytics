// Neon Postgres client (pooled endpoint, nodejs runtime).
//
// IMPORTANT: every route that imports `db` must run in the nodejs runtime.
// Do NOT set `export const runtime = "edge"` on any server component, route
// handler, or middleware that touches the database — the @neondatabase/serverless
// Pool driver uses the WebSocket protocol and the `ws` package, neither of
// which work in Vercel's edge runtime. Next.js 16 defaults to nodejs for
// server components and route handlers; the do-nothing path is correct.
//
// Driver choice rationale: ADR-0008 (single deployment surface, chunked
// transactional ingestion via jobQueue) requires real multi-statement
// transactions, which the HTTP driver cannot provide. See docs/schema-design.md
// for the broader Drizzle convention set.

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });
export type Db = typeof db;
