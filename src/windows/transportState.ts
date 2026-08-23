import { formatTimestamp } from '../time'

/**
 * Pure logic for the dock timeline and the play/pause/volume controls
 * (Task 13) - the part of the brief's testing-reality note ("extract pure
 * logic ... into a tested module; JSX thin") that doesn't need a DOM, a
 * <video>, or a uikit tree to verify. `DockTransport.tsx`/`ControlsWindow.tsx`
 * are deliberately thin glue over this, the same split `libraryState.ts` and
 * `videoWindowState.ts` already established for this app.
 */

/** Clamps to [0, 1] - every fraction in this module is a position along the timeline's width. */
export function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  return Math.min(1, Math.max(0, fraction))
}

/**
 * Where a drag/click at `fraction` along the track lands in playback time.
 * `durationS` <=0 (no episode yet, or a malformed 0-duration one) maps
 * everything to 0 rather than dividing by zero or returning NaN/Infinity -
 * there is nowhere else on the timeline to land.
 */
export function fractionToSeconds(fraction: number, durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 0
  return clampFraction(fraction) * durationS
}

/** The inverse of `fractionToSeconds` - how far along the track `seconds` sits, for sizing the fill bar. */
export function secondsToFraction(seconds: number, durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 0
  return clampFraction(seconds / durationS)
}

/**
 * `current`/`total`, both rendered in the SAME shape - "M:SS" when the
 * episode is under an hour, "H:MM:SS" once it isn't - so a pair never mixes
 * short and long forms (see `formatTimestamp`'s doc comment in `../time`).
 * The decision is made once, from the episode's total duration, not per
 * number - a `currentS` that happens to still be under 60 minutes late in a
 * >=1h episode still renders with the hour digit, matching its own total.
 *
 * Returned as separate parts (not a single joined string) so a caller that
 * needs to render them in two different `<Text>` nodes - with the track
 * between them - doesn't have to re-split a "cur / total" string back apart.
 */
export function transportTimeParts(currentS: number, durationS: number): { current: string; total: string } {
  const includeHours = durationS >= 3600
  return {
    current: formatTimestamp(currentS, includeHours),
    total: formatTimestamp(durationS, includeHours),
  }
}

/** `transportTimeParts` joined as "current / total" - for a caller that wants one string. */
export function transportTimeLabel(currentS: number, durationS: number): string {
  const { current, total } = transportTimeParts(currentS, durationS)
  return `${current} / ${total}`
}

export type PlaybackVisualState = 'play' | 'pause' | 'loading'

/**
 * What the transport button should show. Not just `intentPlaying`'s negation
 * - the button's own click always toggles INTENT (play()/pause() on the
 * engine), but while a stall has the engine's elements paused out from under
 * that intent (buffering), showing the ordinary "Pause" icon would read as a
 * stuck/broken control, so this is its own visible state instead. Clicking a
 * `loading` button behaves exactly like clicking a `pause` one (it calls
 * `pause()`) - only the icon/label differ.
 */
export function derivePlaybackVisualState(intentPlaying: boolean, stalled: boolean): PlaybackVisualState {
  if (!intentPlaying) return 'play'
  return stalled ? 'loading' : 'pause'
}

/** Volume steps in units of 0.1, clamped to [0, 1] and rounded to avoid float drift (e.g. 0.30000000000000004). */
export function stepVolume(current: number, deltaSteps: number): number {
  const stepped = Math.round((current + deltaSteps * 0.1) * 10) / 10
  return Math.min(1, Math.max(0, stepped))
}

/** Volume as a whole-number percentage for display - "70", not "0.7" or "70.00000000000001". */
export function volumeToPercent(volume: number): number {
  return Math.round(clampFraction(volume) * 100)
}
