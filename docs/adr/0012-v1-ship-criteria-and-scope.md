# v1 ship criteria and scope cuts

## v1 ship criteria

v1 ships when all six criteria are met. Each is necessary; none is sufficient on its own.

1. **All 6 gated views feature-complete with real current-season data** — Slate Dashboard, Game Detail Page, Player Page, Props Page, Team Page, Team Leaderboard.
2. **One substantive published investigation** in the research section, demonstrating the MDX pipeline + interactive charts (snapshot or live, per ADR-0007) end-to-end. The bar is "one piece worth publishing," not "one piece, any piece" — a hello-world post or methodology stub does not count. The piece must show real analytical thinking the kind of which a reader (hiring manager, fellow analyst) could form an informed opinion from.
3. **Weekly post-game ingestion stable for 3–4 consecutive weeks** without manual intervention, including at least one observed recovery from a minor failure (Odds API hiccup, flaky weather call, transient parquet read error). Reliability evidence, not absence of failure.
4. **Analytical verification**: at least 3 games' worth of matchup edges and ELO outcomes hand-computed and verified to match the system's outputs. The analytical equivalent of "tests pass" — proves the math is right, not just that data is flowing.
5. **Clerk auth working** with all three tiers (public / friend-gated / admin, per ADR-0005) enforced correctly across the route surface.
6. **Deployed under the portfolio domain** with public surfaces indexable and gated surfaces requiring auth.

Note: the Team Leaderboard view (32-row sortable table of team-week metrics) was originally deferred but promoted to v1 because the underlying data is already materialised in `teamWeekStats` — the view is a single page over existing data, roughly one day of work, and answers research questions that drilling into specific games cannot ("which teams have been trending up most over the last 3 weeks").

## v2 candidates — deferred from v1, on the v2 roadmap

Anticipated; the schema and architecture leave room without committing to timing.

- **DVOA integration** — conditional on subscribing to FootballOutsiders/FTN data; redundant if v2 builds own position-role rankings instead.
- **Position-role-specific defensive rankings** — own methodology using nflverse data. The likely v2 path; more interesting portfolio work than ingesting someone else's product.
- **`gamePrediction` table + numeric predicted scores section** on Game Detail Page (see ADR-0004 and Q4 deliberation).
- **ELO margin-of-victory adjustment** (ADR-0004).
- **Variance-aware prop ranking** — distribution-aware metrics beyond the v1 mean-based dual-edge approach.
- **Live in-game state beyond the live-score badge** — dedicated v2 milestone, not a casual addition.
- **Live in-game prop research workflow** ("second-half props research while game is in play").
- **Per-user features** — preferences, pick tracking, favourite teams, alerts (ADR-0005). Dedicated v2 milestone.
- **All-32-teams ELO trajectory chart** as a standalone visualisation.
- **Historical line-tracking visualisation** for prop lines or game lines over time.
- **Head-to-head comparison views** — team-vs-team or player-vs-player side-by-side.
- **Defensive player analysis** — individual defensive player stats (sacks, INTs, tackles, coverage metrics). v1 is offence-focused; this is a scope decision tied to the prop-research workflow shape, not an oversight.
- **Special teams analysis** beyond team-level aggregates — kicker, punter, return game stats.
- **Historical seasons in the gated app** — v1 views assume current season. Historical data exists via the backfill script (ADR-0008) for research purposes but isn't a UI mode.

## v3+ — not on the v2 roadmap

Explicitly off the near-term horizon. Naming them prevents drift but doesn't commit to ever building them.

- **Multi-author research section / guest contributors** — strategic question about what the site is, not a feature decision.
- **Event-driven ingestion triggers** (vs scheduled cron) — current cron is fine for years; this is a "scale problem" change.
- **Backtesting personal picks against actuals** — requires picks table + UI + friend coordination + backtest framework. Multi-week project; would also re-open ADR-0001's read-side stance.
- **Mobile-optimised UI** — v1 and v2 are desktop-first, responsive-only. Friends research on laptops.
- **Notification system** — email/push when lines move, injuries change, investigations publish. Requires infrastructure that the small audience doesn't justify.
- **Public API** — data consumption via API rather than UI.

## How to use this list

When a question arises mid-build — "should X be in v1?" — the first check is "is X on the in-or-out list above?"

- **If yes**, follow that classification. The decision is already made; don't relitigate.
- **If no**, X wasn't anticipated in the design conversation and is a real new decision. Make it against the principles in the surrounding ADRs (read-side stance, wrong-shape-vs-just-slow, engine-first sequencing, single deployment surface, etc.) — not against vibes.

The list exists to make cheap decisions cheap and force expensive decisions to be visible.
