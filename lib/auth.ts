// Tier-aware auth helpers for server components, route handlers, and
// server actions. The proxy enforces "signed in" on gated routes;
// these helpers enforce "signed in AND on the access list at tier X."
//
// Usage:
//   import { requireFriendTier } from "@/lib/auth";
//   export default async function DashboardPage() {
//     await requireFriendTier(); // redirects to /access-denied if not friend/admin
//     // ...
//   }
//
// Admin implies friend: requireFriendTier accepts both friend and admin;
// requireAdminTier accepts only admin. Encoded here so callers never
// special-case the implication themselves.

import "server-only";

import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cache } from "react";

export type UserTier = "friend" | "admin";

// Augments Clerk's UserPublicMetadata interface so user.publicMetadata.tier
// is typed across the codebase. Set via the Clerk dashboard manually for
// each user; no database table is required (consistent with ADR-0005's
// "identity lives in Clerk's managed user store" stance).
declare global {
  interface UserPublicMetadata {
    tier?: UserTier;
  }
}

/**
 * Returns the current user's tier from Clerk publicMetadata, or null if
 * signed out or unauthorized (signed in but no tier set). Memoized via
 * React's cache() so multiple calls within a single render pass dedupe
 * to a single Clerk API roundtrip.
 */
export const getUserTier = cache(async (): Promise<UserTier | null> => {
  const user = await currentUser();
  if (!user) return null;
  const tier = user.publicMetadata.tier;
  return tier === "friend" || tier === "admin" ? tier : null;
});

/**
 * Asserts the current user has friend tier or better (admin counts).
 * Redirects to /access-denied otherwise. Never returns the failure path —
 * redirect() throws, so callers can treat the return value as guaranteed.
 */
export async function requireFriendTier(): Promise<UserTier> {
  const tier = await getUserTier();
  if (tier === "friend" || tier === "admin") return tier;
  redirect("/access-denied");
}

/**
 * Asserts the current user has admin tier specifically. Friend-tier users
 * get redirected to /access-denied (write supersedes read; friend-only
 * users cannot reach admin write surfaces).
 */
export async function requireAdminTier(): Promise<"admin"> {
  const tier = await getUserTier();
  if (tier === "admin") return "admin";
  redirect("/access-denied");
}
