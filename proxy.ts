// Auth proxy (formerly middleware.ts — renamed to proxy.ts in Next.js 16;
// see node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md).
//
// Responsibility: route-level auth gate only.
//   - Public routes pass through (no auth check).
//   - Everything else requires a signed-in Clerk session; `auth.protect()`
//     redirects unauthenticated users to /sign-in.
//
// Tier-level enforcement (friend vs admin) is handled in lib/auth.ts via
// requireFriendTier() / requireAdminTier() called from page components —
// not here. Rationale per grilling Q14: "admin implies friend access
// encoded in helpers, not in middleware logic."

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/research(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/access-denied",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and common static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Run on API routes too.
    "/(api|trpc)(.*)",
  ],
};
