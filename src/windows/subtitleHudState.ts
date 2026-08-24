import type { Cue, OcSegment } from '../opencast/types'
import { formatTimestamp } from '../time'
import { activeSegmentIndex, truncateOcrText } from './chaptersState'
import { activeCueIndex } from './transcriptState'

/**
 * The pure, unit-tested logic behind `SubtitleHud.tsx` - which cue's text is
 * "on screen" right now, and what the seek-preview readout should say - kept
 * out of the `<HeadLocked>` component for the same reason every other
 * window's rendering logic is split out in this app.
 */

/** The cue currently "on screen" at `tMs`, or `null` when none is active (a gap, or before/after every cue). Built on `transcriptState.ts`'s `activeCueIndex` rather than re-deriving "which cue contains this time" a second time. */
export function activeCue(cues: Cue[], tMs: number): Cue | null {
  const index = activeCueIndex(cues, tMs)
  return index >= 0 ? cues[index] : null
}

export interface SeekFeedback {
  /** `M:SS`/`H:MM:SS` at the preview position. */
  timeLabel: string
  /** The chapter/segment title at that position, or `null` when the episode has no segments (or none qualify). */
  chapterTitle: string | null
}

/** How long a chapter title may render in the HUD's single-line seek-feedback readout before being truncated - tighter than `chaptersState.ts`'s own `OCR_MAX_CHARS` (120), since this shares one line with the timestamp in a HUD panel, not a whole tile. */
export const SEEK_FEEDBACK_CHAPTER_MAX_CHARS = 60

/**
 * The seek-preview HUD readout (spec §8): `null` while no drag is in
 * progress (`previewS === null`, the caller's own mount gate), otherwise the
 * target time plus - when the episode has segments - the chapter/segment
 * title at that position. Reuses `chaptersState.ts`'s `activeSegmentIndex`
 * for the chapter lookup rather than a second "which segment is active"
 * implementation (Task 14 already owns that logic).
 */
export function seekFeedback(segments: OcSegment[], previewS: number | null, durationMs: number): SeekFeedback | null {
  if (previewS === null) return null
  const includeHours = durationMs >= 3_600_000
  const timeLabel = formatTimestamp(previewS, includeHours)
  const index = activeSegmentIndex(segments, previewS)
  const chapterTitle = index >= 0 ? truncateOcrText(segments[index].text, SEEK_FEEDBACK_CHAPTER_MAX_CHARS) : null
  return { timeLabel, chapterTitle }
}

/**
 * ## Caption size
 *
 * The HUD's world size is a `<group scale>` around `<HeadLocked>` -
 * sphere-shell's README documents that as the supported way to rescale a
 * head-locked container, because uikit's own pixel-to-meter conversion
 * (`pixelSize`, 0.01 m/px) is fixed and `<HeadLocked>` has no size prop. It is
 * also the right mechanism for TEXT specifically: uikit renders glyphs from an
 * SDF atlas, so a uniform transform scale stays crisp at any factor, whereas
 * driving `fontSize` instead would reflow the caption (different wrap points,
 * a different panel shape) on every size step and leave the backdrop's padding
 * and corner radius at a fixed pixel size that no longer matches the text.
 *
 * ### Why the steps are all well under 1
 *
 * The raw design size is enormous in world space: the caption panel is
 * `SUBTITLE_MAX_WIDTH_PX` + padding wide at 0.01 m/px - about 5.6 m - hanging
 * 1.2 m from the viewer, where the magic window's own 70-degree frustum is only
 * about 2.7 m wide. That is the „passen nicht in das Browserfenster" the user
 * reported. So `1.0` is not a sensible default here; these factors are the
 * browser-measured retune, and the comment on each one is the panel width they
 * produce in metres.
 *
 * RETUNED BROWSER-FIRST. The Quest look is unverified - see
 * `docs/QUEST-VALIDATION-PLAYER.md`.
 */
// Typed `readonly number[]` rather than `as const`: a tuple of literal types
// would make every derived constant (the default, MIN/MAX) a literal type too,
// which then fights every ordinary `number` it is compared or assigned to.
export const SUBTITLE_SCALE_STEPS: readonly number[] = [0.22, 0.3, 0.4]

/** One-character labels for `SUBTITLE_SCALE_STEPS`, index for index - short enough for a dock button. */
export const SUBTITLE_SCALE_LABELS: readonly string[] = ['S', 'M', 'L']

/** The default caption size: the middle step. */
export const DEFAULT_SUBTITLE_SCALE = SUBTITLE_SCALE_STEPS[1]

/** Smallest/largest caption scale the store will accept - the ends of `SUBTITLE_SCALE_STEPS`, exported so the store can clamp without importing the whole steps array. */
export const MIN_SUBTITLE_SCALE = SUBTITLE_SCALE_STEPS[0]
export const MAX_SUBTITLE_SCALE = SUBTITLE_SCALE_STEPS[SUBTITLE_SCALE_STEPS.length - 1]

/**
 * Which step a scale value corresponds to - the NEAREST one, not an exact
 * match. The store holds a plain clamped number rather than an index (one
 * writer, one value, no "index into an array the store cannot see"), so this
 * has to cope with a value that is not exactly a step: a clamp landing between
 * two of them, or a step list that changed under a value from an earlier build.
 * Nearest keeps the label and the next cycle step sane in all of those cases
 * instead of falling back to step 0 and silently resetting the user's choice.
 */
export function subtitleScaleIndex(scale: number): number {
  if (!Number.isFinite(scale)) return SUBTITLE_SCALE_STEPS.indexOf(DEFAULT_SUBTITLE_SCALE)
  let best = 0
  for (let i = 1; i < SUBTITLE_SCALE_STEPS.length; i++) {
    if (Math.abs(SUBTITLE_SCALE_STEPS[i] - scale) < Math.abs(SUBTITLE_SCALE_STEPS[best] - scale)) best = i
  }
  return best
}

/**
 * The next size step, wrapping round from the largest back to the smallest -
 * so the dock needs ONE button for caption size rather than a -/+ pair, which
 * matters on a row that already carries play/pause, the timeline, the time
 * readout, mute and volume. Three steps make the wrap cheap: the worst case
 * for reaching any size is two clicks.
 */
export function cycleSubtitleScale(scale: number): number {
  return SUBTITLE_SCALE_STEPS[(subtitleScaleIndex(scale) + 1) % SUBTITLE_SCALE_STEPS.length]
}

/** The one-character label for the step `scale` is on ("S"/"M"/"L") - what the dock's size button displays. */
export function subtitleScaleLabel(scale: number): string {
  return SUBTITLE_SCALE_LABELS[subtitleScaleIndex(scale)]
}
