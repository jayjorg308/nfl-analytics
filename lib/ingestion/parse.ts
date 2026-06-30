// nflverse parquet type-boundary conversions (ADR-0013 / docs/parquet-mapping.md).
// hyparquet's typed accessors do NOT auto-convert these encodings; apply at parse time.

/** Nullable number passthrough (parquet DOUBLE/INT → JS number). */
export function asNum(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/** Nullable integer (truncates; for yardage / counts stored as DOUBLE or INT). */
export function asInt(v: unknown): number | null {
  return v == null ? null : Math.trunc(Number(v));
}

/** Nullable string (BYTE_ARRAY → string). */
export function asStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

/**
 * Boolean-like flags are stored as DOUBLE 0/1 (pass, rush, complete_pass, success,
 * drive_inside20, drive_ended_with_score, …) — convert explicitly (ADR-0013).
 */
export function asBool(v: unknown): boolean | null {
  return v == null ? null : Number(v) !== 0;
}

/**
 * `MM:SS` (BYTE_ARRAY) → integer seconds. Used for `time` (within-quarter, →
 * play.timeRemainingSeconds) and `drive_time_of_possession` (→ drive.timeOfPossession).
 * Returns null for null/unparseable input.
 */
export function mmssToSeconds(v: unknown): number | null {
  if (v == null) return null;
  const m = String(v).match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
