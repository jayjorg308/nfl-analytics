# NFL Analytics

A personal NFL analytics platform supporting a weekly research workflow shared with a small known group of friends. Outputs include prop and game-line betting decisions, game-watching context, and ad-hoc analytical investigations into NFL questions the author genuinely cares about. The platform is also a portfolio piece for the author's data work, and the v1 surface migrates analyses that previously lived in Google Sheets. The database is a **read-side analytical store** — facts about the world plus derivations — and explicitly not a system of record for user-generated artifacts like picks, notes, or predictions; friends track those in their own sportsbooks and spreadsheets.

## Language

### Research vocabulary

**Research workflow**:
The weekly drill-down from slate → game → player → prop that produces the project's outputs. Replaces the previous Google Sheets workflow with guided navigation rather than tab-switching across 8 tabs. Distinct from "investigation" (the *output*) and "research section" (the *publication surface*).

**Investigation**:
A long-form analytical work product — a self-contained piece of NFL analysis with methodology, data, and findings — published in the research section. The canonical term for this; outputs of the research workflow that are written up for publication. Three subtypes are distinguished by what kind of claim the piece is making (and consequently how its chart data is sourced — see ADR-0007):
- **Historical research investigation** — a frozen analysis at a specific point in time (e.g. "is L3-vs-season actually predictive?"). Findings don't auto-update; charts use data snapshotted at publish time.
- **Working dashboard investigation** — a current-state view (e.g. "this season's EPA leaders," "team ELO trajectories"). Charts live-query Postgres; the piece behaves like a public dashboard more than an essay.
- **Hybrid investigation** — a frozen analytical core plus live "watch this in the wild" components. Some charts snapshot, some live, chosen per chart.
_Avoid_: analytical investigation, research piece, study, post

**Research section**:
The public-facing area of the site (`/research/*`) where investigations are published. Indexable, shareable, no auth required. The portfolio surface of the project — where hiring managers and the broader sports-analytics community see the analytical work — distinct from the gated active-research surfaces (slate dashboard, game/player/props/team pages) which are the operational tool.
_Avoid_: research portal, blog

**Slate**:
The set of games in a given NFL week. The Slate Dashboard is the marquee view and the entry point of every research session.

**Edge**:
A quantified advantage. For matchups, the signed sum of offensive and defensive EPA/play in a phase — positive favours offence, negative favours defence (see ADR-0002 for sign convention and selection rules). For props, the gap between a player's recent production and the sportsbook line; v1 computes two parallel prop edges per prop — vs season average and vs L3 average — displayed side-by-side because they tell different stories and disagreement between them is itself a signal.
_Avoid_: value, play (overloaded in betting parlance)

**Defensive EPA convention**:
Defensive EPA is stored as "what the defence allows per play." A strong defence has a *negative* defensive EPA (suppresses expected points); a weak defence has *positive* (gives up expected points). This convention is load-bearing for the edge formula — read ADR-0002 before touching any code that combines offensive and defensive EPA.

**Matchup**:
A directional comparison between an offense and a defense in a specific phase (pass or rush). A game is decomposed into four matchups: home-pass-O vs away-pass-D, home-rush-O vs away-rush-D, and the two reciprocals. Surfaced as "When SEA has the ball / When NE has the ball" in the UI.

**Splits**:
The standard set of cuts applied to a stat: Season, L3, L5, Home, Away. Player and team views render stats across these splits by default.

**Strength of schedule (SOS)**:
A team's schedule difficulty, surfaced as a 1–32 rank where **1 = hardest** — the rank inverts the naive reading, so guard against displaying it backwards. Measured by the average ELO of opponents. Two measures share the `sosRank` column: the in-season value is *realized* (opponents already played, each at its rating when that game happened); the week-0 value is *projected* (the full scheduled slate, each opponent at its preseason baseline rating), because no games have been played yet. See ADR-0023.
_Avoid_: assuming 1 = easiest; conflating the projected week-0 value with the realized in-season one.

**L3 / L5**:
Shorthand for "last 3 games" / "last 5 games" played by a player or team. "L3 yds/game" = average yards per game over the last 3 games played.

**Matchup-implied lean**:
A qualitative directional read on a game's total or spread derived from EPA matchup data alone, with no model behind it. Surfaced as one line on the Game Detail Page ("Vegas total 45.5 · Matchup-implied lean: under"). Distinct from a *predicted score* — that's a numeric, model-driven output (deferred to v2 with the `gamePrediction` table).
_Avoid_: prediction, projection (those imply numeric model output)

### Prop research

**Hit rate (closing)**:
A player's historical track record against each prior game's *closing* line for a given prop type, expressed as hits / games played. The primary "is this player a frequent over-hitter" signal; stable across views. Denominator counts only games where the player had a relevant `playerGame` record and the prop had a non-null `actualValue` — so injured/inactive games are excluded automatically. Pushes excluded from both numerator and denominator.

**Hit rate vs current line**:
A backtest of the current upcoming game's posted line against the player's prior games this season — "if this exact line had been posted every game this season, how often would the over have won?" Surfaced on the Game Detail Page alongside the closing-line hit rate, never under the same column header. Exposes distribution sensitivity that the prop edge alone obscures: two players with the same edge can have very different "vs current line" hit rates if their game-to-game variance differs.
_Avoid_: collapsing into "hit rate" without qualifier — the two numbers tell different stories and conflating them loses information

**Hit margin**:
The signed delta between actual value and line in a given game. A 78-yard performance against a 65.5 line is hit margin +12.5. Shown as a column on the Player Page props history table because hit rate alone hides whether overs were squeakers or blowouts.

**Push**:
A prop where actual value exactly equals the line — possible on whole-number lines (common on receptions, rare on yardage). Excluded from hit rate numerator and denominator; shown separately in the display ("8/13 over, 1 push").
