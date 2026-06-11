// Season + current-week helpers.
//
// Per docs/schema-design.md → Data placement principles #2: derived state
// computed at read time unless temporal-correctness / wrong-shape / atomicity
// forces caching. Current week is derived from the game table at request
// time. Hardcoding (e.g. const CURRENT_WEEK = 2) would silently break when
// Slice 3 ingestion lands real data.
//
// Both helpers memoize via React's cache() so multiple calls within a
// single render pass dedupe to one DB query.

import "server-only";

import { and, asc, desc, eq, ne } from "drizzle-orm";
import { cache } from "react";

import { db } from "@/db";
import { game, season } from "@/db/schema";

/**
 * Returns the most-recently-seeded season. For Slice 1 with one seeded
 * season this is deterministic; for v1+ it picks the highest-year row,
 * which is correct in-season and during the off-season (last completed
 * season's data stays visible until the next season's data lands).
 */
export const getCurrentSeason = cache(
  async (): Promise<{ id: number; year: number } | null> => {
    const rows = await db
      .select({ id: season.id, year: season.year })
      .from(season)
      .orderBy(desc(season.year))
      .limit(1);
    return rows[0] ?? null;
  },
);

/**
 * Returns the lowest week number in the given season that has at least
 * one game not yet final. This is "the current week's slate" — i.e. the
 * earliest upcoming or in-progress week.
 *
 * Returns null if every game in the season is final (off-season, post-
 * Super Bowl). Callers should render an end-of-season state in that case.
 */
export const getCurrentWeek = cache(
  async (seasonId: number): Promise<number | null> => {
    const rows = await db
      .select({ week: game.week })
      .from(game)
      .where(and(eq(game.seasonId, seasonId), ne(game.status, "final")))
      .orderBy(asc(game.week))
      .limit(1);
    return rows[0]?.week ?? null;
  },
);
