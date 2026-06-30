// DRAIN cron (ADR-0016): every 30 min during the active ingestion windows. Processes whatever
// the drain query returns, no discovery. Concurrent primary+drain invocations are safe — the
// drain's FOR UPDATE SKIP LOCKED claim handles it (validated chunk 5).

import { NextResponse } from "next/server";

import { db } from "@/db";
import { drainOnce } from "@/lib/ingestion/drain";
import { verifyCron } from "@/lib/ingestion/cron-auth";

export const runtime = "nodejs"; // ADR-0008: pooled client + FOR UPDATE SKIP LOCKED — never edge
export const maxDuration = 300; // must equal drain.ts DRAIN_BUDGET_MS (300_000); see ADR-0030
export const dynamic = "force-dynamic"; // never statically cache a mutating cron GET

export async function GET(req: Request) {
  const unauthorized = verifyCron(req);
  if (unauthorized) return unauthorized;

  const drained = await drainOnce(db, new Date());
  return NextResponse.json({ drained });
}
