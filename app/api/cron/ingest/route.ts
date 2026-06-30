// PRIMARY cron (ADR-0016): Mon/Tue/Fri 10:00 UTC. Discover expected work, then drain it.
// Vercel invokes crons via GET. Auth is the in-route CRON_SECRET check (ADR-0030); proxy.ts
// only allowlists the path so Clerk does not redirect this route to /sign-in.

import { NextResponse } from "next/server";

import { db } from "@/db";
import { enumerateAndEnqueue } from "@/lib/ingestion/discovery";
import { drainOnce } from "@/lib/ingestion/drain";
import { currentSeasonYear, fetchSchedule } from "@/lib/ingestion/schedule";
import { verifyCron } from "@/lib/ingestion/cron-auth";

export const runtime = "nodejs"; // ADR-0008: pooled client + FOR UPDATE SKIP LOCKED — never edge
export const maxDuration = 300; // must equal drain.ts DRAIN_BUDGET_MS (300_000); see ADR-0030
export const dynamic = "force-dynamic"; // never statically cache a mutating cron GET

export async function GET(req: Request) {
  const unauthorized = verifyCron(req);
  if (unauthorized) return unauthorized;

  const now = new Date();
  const schedule = await fetchSchedule(currentSeasonYear(now));
  const enqueued = await enumerateAndEnqueue(db, schedule, now);
  const drained = await drainOnce(db, now);

  return NextResponse.json({ enqueued, drained });
}
