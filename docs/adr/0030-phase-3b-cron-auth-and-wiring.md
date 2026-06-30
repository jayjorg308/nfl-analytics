# Phase 3b cron auth + route wiring — amends ADR-0016

ADR-0016 settled Phase 3b's cron *cadence* (a primary Mon/Tue/Fri scheduled cron + a 30-minute
drain cron in the active windows, both dispatching through the handlers). It left the *wiring*
open: how the cron routes authenticate, and how they coexist with the app's Clerk auth gate
(`proxy.ts`). This ADR closes that. It amends ADR-0016 (wiring only — the cadence is unchanged);
a back-reference note is added there.

## The non-obvious gotcha this design exists to avoid

The app's `proxy.ts` runs Clerk on every route including `/api/*`, and `auth.protect()`
**redirects** an unauthenticated request to `/sign-in` (a `3xx`). **Vercel cron does not follow
redirects, and reads a `3xx` as a successful invocation.** So an un-allowlisted cron route would
**silently no-op every fire** — the cron "succeeds" (302), zero work happens, and nothing alerts.
This is a quiet-failure trap, not a loud one. The allowlist below is therefore *mandatory*, not
cosmetic.

## Decision (author-ratified: Option A)

1. **Allowlist the cron paths in `proxy.ts`** (`/api/cron/ingest`, `/api/cron/drain`) so Clerk
   stops redirecting them. This is the one line Option A costs.
2. **The real gate is an in-route `CRON_SECRET` check**, not `proxy.ts`. A shared `verifyCron(req)`
   helper checks `Authorization === \`Bearer ${process.env.CRON_SECRET}\``, returning `401` on
   mismatch. It **fails closed**: an unset `CRON_SECRET` yields `401`, so the route never runs
   unauthenticated. Vercel auto-sends this header on cron invocations.
3. The secret-check lives **in the route, not `proxy.ts`** — keeping the middleware single-purpose
   (the Slice-3 grilling Q14 principle: auth-redirect is `proxy.ts`'s only job; tier/role and now
   cron-secret enforcement live at their point of use, not in middleware branching).

Considered and rejected: gating the cron in `proxy.ts` itself (couples a second concern into the
middleware, Q14); leaving the routes behind Clerk (the silent-no-op trap above).

## The routes

Two `GET` handlers (Vercel invokes crons via GET), each calling `verifyCron` first:

- **`/api/cron/ingest`** (primary): `enumerateAndEnqueue(db, schedule, now)` → `drainOnce(db, now)`
  — discover then process. Returns `{ enqueued, drained }` for cron-log observability. The target
  season is derived from `now` (`currentSeasonYear`), forward-only (never the Phase-3a-owned past
  seasons, ADR-0015).
- **`/api/cron/drain`** (drain): `drainOnce(db, now)` only; returns the summary.

Both declare the route-segment config:

```ts
export const runtime = "nodejs";        // ADR-0008 — pooled client + FOR UPDATE SKIP LOCKED, never edge
export const maxDuration = 300;         // makes the drain's 300s budget REAL (undeclared ≠ enforced)
export const dynamic = "force-dynamic"; // never statically cache a mutating cron GET
```

### Critical coupling: `maxDuration` ↔ `DRAIN_BUDGET_MS`

`maxDuration = 300` **must equal** `drain.ts`'s `DRAIN_BUDGET_MS = 300_000` **and** sit within the
Vercel plan's function-duration cap. If the plan caps function duration lower (e.g. 60s), **both**
must drop to match and `DRAIN_HEADROOM_MS` be re-checked against the measured per-job wall time
(~2.8s/ingest; headroom 30s). The drain's self-imposed budget is meaningless if the platform kills
the function earlier. **Deploy-time confirmation required:** the plan permits 300s functions and
the every-30-min drain frequency (lower tiers have historically restricted cron frequency to
daily). ADR-0008 already requires Pro tier; this is consistent.

## vercel.json schedules (anchored to ADR-0016, UTC)

- Primary: `0 10 * * 1,2,5` (Mon/Tue/Fri 10:00).
- Drain (ADR-0016 active windows — Sun 23:00→Tue 18:00 and Thu 23:00→Fri 18:00 — expressed as
  three entries by combining the symmetric window days):
  - `0,30 23 * * 0,4` (Sun & Thu 23:00/23:30 — each window's opening hour)
  - `0,30 * * * 1` (all Monday)
  - `0,30 0-18 * * 2,5` (Tue & Fri through ~18:00)

Edge slop is ≤30 min past a window boundary, which is a cheap empty-queue no-op. Concurrent
primary+drain fires are safe — the drain's `FOR UPDATE SKIP LOCKED` claim handles it.

## CRON_SECRET provisioning

`openssl rand -hex 32`, stored in `.env.local` (gitignored) for local route-testing. **It must
ALSO be set in the Vercel project env (Production) before the prod crons can authenticate** —
otherwise every prod cron `401`s (fail-closed).

## Prod-sequencing checklist (deploy is the author's manual step — not executed here)

`vercel.json` crons activate **on deploy**, but prod still lacks migrations `0002`/`0003` (no
`job_queue` / `play` / `drive`, no `game.playsFrozenAt`). Wrong order = a `500` every cron fire.
Correct order:

1. Apply migrations **0002 then 0003** to **prod** Neon.
2. Set **CRON_SECRET** in the Vercel Production env.
3. **Then** deploy with `vercel.json` (the crons go live on this deploy).

(The dev/working DB was migrated in Chunk 1; prod is the separate deploy step.)

## What this does NOT cover (PROD-only, not fakeable in dev)

The true end-to-end — Vercel invoking the crons on schedule against live 2026 data — is provable
only in prod during the 2026 season: the ship-criterion hand-verification (≥3 games re-derived for
forward ELO/`sosRank` continuity) and the pre-registered live watch-items (playoff-schedule
publication timing for the week-19 bye derivation, ADR-0026/0028; completeness-gate threshold
tuning, ADR-0019; plays/game already measured, ADR-0026). Dev validation covers everything else.

## Cross-references

- ADR-0016 — cron cadence/drain/retry this wires; amended (wiring only, cadence unchanged).
- ADR-0008 — nodejs runtime + Pro-tier requirement; the duration/frequency caps referenced here.
- ADR-0028 — discovery (the primary cron's enqueue step); schedule-only targeting.
- ADR-0015 — forward-only ownership: the cron targets the current/forward season, never 2021–2025.
