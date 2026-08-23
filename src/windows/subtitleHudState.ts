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
