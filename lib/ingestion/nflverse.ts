// Shared nflverse-release parquet reader (ADR-0029; validated precedent ADR-0013).
//
// Reads nflverse-data GitHub release assets over HTTP with hyparquet, column-filtered
// to keep fetches small (hyparquet issues HTTP range requests per column chunk). This
// is the single production reader for BOTH the schedule and the pbp (one library, one
// source, one set of parsing conventions — ADR-0029).
//
// nodejs runtime ONLY: parquet parsing + the downstream pooled DB client are node-side,
// never edge (db/index.ts).

import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";

const RELEASE_BASE =
  "https://github.com/nflverse/nflverse-data/releases/download";

/**
 * The schedule asset is a SINGLE all-seasons file (`games.parquet`). Callers filter
 * by the `season` column. Confirmed the same release `nfl_data_py.import_schedules`
 * resolves to (ADR-0029).
 */
export const scheduleReleaseUrl = (): string =>
  `${RELEASE_BASE}/schedules/games.parquet`;

/**
 * One pbp asset per season (`play_by_play_{year}.parquet`). 404 until a season's first
 * release lands — the same release `nfl_data_py.import_pbp_data` resolves to (ADR-0029).
 */
export const pbpReleaseUrl = (seasonYear: number): string =>
  `${RELEASE_BASE}/pbp/play_by_play_${seasonYear}.parquet`;

/**
 * Pull a release parquet over HTTP and return its rows as plain objects keyed by
 * column name. `columns` is a projection (which columns to fetch + parse) — always
 * pass it to keep the fetch small. Row-GROUP predicate pushdown is a separate,
 * deferred optimization (ADR-0029 / ADR-0026); row filtering stays in memory at v1.
 */
export async function readReleaseParquet(
  url: string,
  columns: string[],
): Promise<Record<string, unknown>[]> {
  const file = await asyncBufferFromUrl({ url });
  const rows = await parquetReadObjects({ file, columns });
  return rows as Record<string, unknown>[];
}
