/**
 * Shared seconds -> {h,m,s} split and zero-padding, so the two places that
 * format a duration (`libraryState.ts`'s tile subtitles, always "H:MM:SS",
 * and `windows/transportState.ts`'s dock timeline, "M:SS" under an hour) do
 * it through one definition instead of two copies of the same div/mod
 * arithmetic drifting apart. Extracted here (not left in `libraryState.ts`,
 * where `formatDuration` originated in Task 11) because neither of the two
 * call sites is "the real owner" of this - it's genuinely shared, low-level
 * formatting with no dependency on episodes, libraries, or the player store.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Rounds and clamps to >=0 first, so a tiny float overshoot (e.g. -0.001) never surfaces as a negative or off-by-one component. */
export function splitSeconds(totalSeconds: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.round(totalSeconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return { h, m, s }
}

/**
 * "H:MM:SS" - hours unpadded (matches common media-player convention:
 * "1:02:03", not "01:02:03"). Always includes the hour component, even when
 * it's "0" - this is the tile-subtitle format from Task 11.
 */
export function formatDuration(durationMs: number): string {
  const { h, m, s } = splitSeconds(durationMs / 1000)
  return `${h}:${pad2(m)}:${pad2(s)}`
}

/**
 * A single timestamp, "M:SS" (no hour digit at all) unless `includeHours` is
 * set, in which case it's "H:MM:SS" - same shape as `formatDuration`. The
 * dock timeline (Task 13) picks `includeHours` once per episode, from whether
 * its total duration is >=1h, so a current-time/duration pair always renders
 * in the SAME shape (both "3:05 / 7:44" or both "1:02:03 / 1:15:00" - never
 * one short and one long).
 */
export function formatTimestamp(seconds: number, includeHours: boolean): string {
  const { h, m, s } = splitSeconds(seconds)
  if (includeHours) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${h * 60 + m}:${pad2(s)}`
}
