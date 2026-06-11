// Skeleton card for the Slate Dashboard. Slice 1 scope: functional render
// of the data elements (identity, records, ELO, top edge, weather, kickoff)
// over a realistic-looking sample. Visual polish is a v1 concern, not Slice 1.

import { getTeamBrand } from "@/data/teams";

// Row type matches the week_summary view's column set. Inferred at the
// call site via `typeof weekSummary.$inferSelect`; we widen here to a
// structural type so this component doesn't import Drizzle.
export type WeekSummaryCard = {
  gameId: number;
  gameDateTime: Date;
  temperature: number | null;
  windMph: number | null;
  precipitationChance: number | null;
  weatherCondition: string | null;
  homeTeamAbbreviation: string;
  homeRecordWins: number;
  homeRecordLosses: number;
  homeRecordTies: number;
  homeEloRating: number;
  awayTeamAbbreviation: string;
  awayRecordWins: number;
  awayRecordLosses: number;
  awayRecordTies: number;
  awayEloRating: number;
  topEdgeLabel: "home_pass" | "home_rush" | "away_pass" | "away_rush";
  topEdgeValue: number;
};

const kickoffFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

const EDGE_LABEL_DISPLAY: Record<WeekSummaryCard["topEdgeLabel"], string> = {
  home_pass: "Home pass",
  home_rush: "Home rush",
  away_pass: "Away pass",
  away_rush: "Away rush",
};

function formatRecord(w: number, l: number, t: number): string {
  return t === 0 ? `${w}-${l}` : `${w}-${l}-${t}`;
}

function formatEdge(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function formatWeather(card: WeekSummaryCard): string | null {
  if (card.temperature == null && card.windMph == null) return null;
  const parts: string[] = [];
  if (card.temperature != null) parts.push(`${card.temperature}°F`);
  if (card.windMph != null) parts.push(`${card.windMph} mph`);
  if (card.weatherCondition) parts.push(card.weatherCondition);
  return parts.join(" · ");
}

export function GameCard({ card }: { card: WeekSummaryCard }) {
  const homeBrand = getTeamBrand(card.homeTeamAbbreviation);
  const awayBrand = getTeamBrand(card.awayTeamAbbreviation);
  const weather = formatWeather(card);

  return (
    <article className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-3 bg-white dark:bg-zinc-950">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">
          <span title={awayBrand.name}>{card.awayTeamAbbreviation}</span>
          <span className="text-zinc-400 mx-1.5">@</span>
          <span title={homeBrand.name}>{card.homeTeamAbbreviation}</span>
        </h2>
        <time className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
          {kickoffFormatter.format(card.gameDateTime)}
        </time>
      </header>

      {weather ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{weather}</p>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">Dome</p>
      )}

      <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
        <dt className="font-medium">{card.awayTeamAbbreviation}</dt>
        <dd className="text-zinc-600 dark:text-zinc-400">
          {formatRecord(card.awayRecordWins, card.awayRecordLosses, card.awayRecordTies)}
        </dd>
        <dd className="text-right text-zinc-500 dark:text-zinc-400">
          ELO {Math.round(card.awayEloRating)}
        </dd>
        <dt className="font-medium">{card.homeTeamAbbreviation}</dt>
        <dd className="text-zinc-600 dark:text-zinc-400">
          {formatRecord(card.homeRecordWins, card.homeRecordLosses, card.homeRecordTies)}
        </dd>
        <dd className="text-right text-zinc-500 dark:text-zinc-400">
          ELO {Math.round(card.homeEloRating)}
        </dd>
      </dl>

      <footer className="flex items-baseline justify-between text-sm border-t border-zinc-100 dark:border-zinc-900 pt-2">
        <span className="text-zinc-500 dark:text-zinc-400">Top edge</span>
        <span className="tabular-nums">
          <span className="font-medium">{EDGE_LABEL_DISPLAY[card.topEdgeLabel]}</span>
          <span className="ml-2">{formatEdge(card.topEdgeValue)}</span>
        </span>
      </footer>
    </article>
  );
}
