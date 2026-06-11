// Slate Dashboard — Slice 1 skeleton.
//
// Reads from the week_summary view, NOT from the underlying tables, per
// ADR-0009 (view-as-read-shape pattern). The view's edge formula is the
// SQL implementation of ADR-0002; this route just renders the result.
//
// Filter chain:
//   1. getCurrentSeason()  → latest seeded season
//   2. getCurrentWeek(id)  → earliest week with games not yet final
//   3. WHERE seasonId=?, week=?  → exactly the current week's cards
//
// Without step 3, all 32 view rows (Week 1 + Week 2) would render with
// the Week 1 cards showing zero edges (joins to week=0 stats by design).

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { weekSummary } from "@/db/schema";
import { GameCard } from "@/components/game-card";
import { requireFriendTier } from "@/lib/auth";
import { getCurrentSeason, getCurrentWeek } from "@/lib/season";

export const metadata = {
  title: "Slate · NFL Analytics",
};

export default async function DashboardPage() {
  await requireFriendTier();

  const season = await getCurrentSeason();
  if (!season) {
    return (
      <main className="flex flex-col flex-1 items-center justify-center p-8">
        <p className="text-zinc-500">No season data has been seeded yet.</p>
      </main>
    );
  }

  const currentWeek = await getCurrentWeek(season.id);
  if (currentWeek == null) {
    return (
      <main className="flex flex-col flex-1 items-center justify-center p-8">
        <p className="text-zinc-500">
          Season {season.year} is complete — no upcoming games.
        </p>
      </main>
    );
  }

  const cards = await db
    .select()
    .from(weekSummary)
    .where(
      and(
        eq(weekSummary.seasonId, season.id),
        eq(weekSummary.week, currentWeek),
      ),
    )
    .orderBy(asc(weekSummary.gameDateTime));

  return (
    <main className="flex flex-col flex-1 p-6 gap-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Week {currentWeek} slate</h1>
        <span className="text-sm text-zinc-500">
          {season.year} season · {cards.length} games
        </span>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {cards.map((card) => (
          <GameCard key={card.gameId} card={card} />
        ))}
      </div>
    </main>
  );
}
