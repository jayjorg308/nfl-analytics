// Cron-route auth gate (ADR-0030). The REAL gate for the Phase 3b cron routes — not the Clerk
// middleware (proxy.ts only allowlists the paths so Clerk stops redirecting them; see ADR-0030
// for why the redirect would otherwise make the cron a silent no-op).
//
// Vercel auto-sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations.

/**
 * Returns a 401 Response if the request is not an authentic cron invocation, else null.
 * FAIL CLOSED: an unset CRON_SECRET yields 401 — the route never runs unauthenticated.
 */
export function verifyCron(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
