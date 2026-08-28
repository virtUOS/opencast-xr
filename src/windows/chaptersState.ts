import type { OcSegment } from '../opencast/types'
import type { MediaListItem } from './MediaList'
import { formatTimestamp } from '../time'

/**
 * The pure, unit-tested logic behind `ChaptersWindow.tsx` - OCR-text
 * truncation, segment-to-tile mapping, and "which segment is active right
 * now" - kept out of the uikit component for the same reason
 * `libraryState.ts`/`videoWindowState.ts` are split from their windows:
 * uikit can't render meaningfully in jsdom, so anything worth a unit test
 * has to live somewhere a test CAN reach.
 */

/**
 * OCR text can run far longer than one tile line - MediaList's own 42-char
 * `TITLE_MAX_CHARS` truncation already applies on top of whatever this
 * produces, but that's MediaList's internal rendering budget, not this
 * task's spec. The brief calls for "~120 chars" independently, so this is a
 * second, explicit truncation in the pure/testable layer that owns the
 * OCR text itself - belt and suspenders, not a contradiction.
 */
export const OCR_MAX_CHARS = 120

// "..." (three ASCII periods), matching MediaList.tsx's own `truncate` - see
// that file's doc comment (and docs/UIKIT-NOTES.md entry 3) for why "…"
// (U+2026) is not safe in this uikit version's default font.
export function truncateOcrText(text: string, max: number = OCR_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** One segment as a MediaList tile: truncated OCR text as the title, its start time as the subtitle, its own preview image (if it has one). */
export function segmentTile(segment: OcSegment, index: number, includeHours: boolean): MediaListItem {
  return {
    // OcSegment carries no id of its own; the index into the episode's
    // `segments` array is stable (segments are never reordered, filtered or
    // paginated after being set on the episode) and unique within one list.
    id: String(index),
    title: truncateOcrText(segment.text),
    subtitle: formatTimestamp(segment.startMs / 1000, includeHours),
    imageUrl: segment.previewUrl,
  }
}

/**
 * Every segment as a tile, in order. `includeHours` is picked once for the
 * whole list from the episode's total duration (>=1h), mirroring
 * `transportState.ts`'s `transportTimeParts` - so every timestamp in the
 * list renders in the SAME shape ("0:35" and "1:02:03" never side by side
 * because one segment happened to be timed differently from another).
 */
export function segmentTiles(segments: OcSegment[], episodeDurationMs: number): MediaListItem[] {
  const includeHours = episodeDurationMs >= 3_600_000
  return segments.map((s, i) => segmentTile(s, i, includeHours))
}

/**
 * Index of the segment whose range contains `currentTimeS` - defined as the
 * segment with the LARGEST `startMs` that is still `<= currentTimeS`, not
 * `start <= t < start+duration`: Opencast's own segment durations are
 * frequently approximate around slide-change boundaries, and the final
 * segment has no reliable end bound at all (it must stay highlighted all
 * the way to the episode's end, not lose its highlight a few ms before
 * `durationMs` is reached). "The latest segment that has started" gives
 * exactly that, and is simpler besides.
 *
 * Robust to unsorted input (a defensive stance, not a documented Opencast
 * guarantee) - picks the tile with the max qualifying `startMs` rather than
 * assuming `segments` is ascending.
 *
 * Returns -1 for an empty list, or when `currentTimeS` precedes every
 * segment's start (defensive; every real or synthetic segment set this app
 * produces starts at or before 0).
 */
export function activeSegmentIndex(segments: OcSegment[], currentTimeS: number): number {
  const currentMs = currentTimeS * 1000
  let best = -1
  let bestStart = -Infinity
  segments.forEach((seg, i) => {
    if (seg.startMs <= currentMs && seg.startMs > bestStart) {
      best = i
      bestStart = seg.startMs
    }
  })
  return best
}

/**
 * Fractions in the OPEN interval (0, 1) along the timeline where a chapter
 * tick mark belongs - one per segment boundary, deliberately EXCLUDING a
 * boundary that lands exactly at the very start (0) or very end
 * (`episodeDurationMs`) of the episode: both already coincide with the
 * track's own rounded end-caps (`DockTransport.tsx`'s `TRACK_HEIGHT_PX`
 * radius), so a tick there would sit on top of geometry that already marks
 * "start"/"end" and would add no information. The FIRST segment always
 * starts at 0 in practice (Opencast's own segmentation, and every synthetic
 * fixture this app produces), so this is what keeps a real episode's tick
 * row from always beginning with a redundant mark at the very left edge.
 *
 * Returns `[]` for no segments or a non-positive duration (defensive - no
 * real or synthetic episode has either, but `episodeDurationMs` reaches this
 * from `episode?.durationMs ?? 0` at the call site, which IS 0 for the one
 * frame before an episode has loaded).
 */
export function segmentTickFractions(segments: OcSegment[], episodeDurationMs: number): number[] {
  // Number.isFinite, not just <= 0: parse.ts builds durations via Number(...),
  // so malformed Opencast metadata arrives here as NaN, and every NaN
  // comparison is false - a bare <= 0 guard would leak a NaN fraction into
  // positionLeft. Same convention as transportState.ts.
  if (!Number.isFinite(episodeDurationMs) || episodeDurationMs <= 0) return []
  const fractions: number[] = []
  for (const seg of segments) {
    if (!Number.isFinite(seg.startMs) || seg.startMs <= 0 || seg.startMs >= episodeDurationMs) continue
    fractions.push(seg.startMs / episodeDurationMs)
  }
  return fractions
}

/** Which half of a split chapter-tile click landed - see `chapterSeekTargetMs`. */
export type ChapterClickRegion = 'image' | 'text'

/**
 * The seek target (ms) for a click on one chapter/segment tile, given which
 * region was clicked.
 *
 * Both regions resolve to the SAME time - the segment's own `startMs` -
 * unlike `TranscriptWindow`'s cues (see `transcriptState.ts`): a chapter
 * tile's "text" is OCR text belonging to the WHOLE segment, not a caption
 * cue with its own independent timestamp inside it, so there is no
 * finer-grained position to jump to than the segment boundary itself,
 * whichever half of the tile was pressed. The `region` parameter is still
 * threaded all the way through (rather than dropped) so the call site
 * documents which region a click came from, and so a future segment shape
 * that DOES carry a finer-grained text timestamp has one place to add that
 * distinction.
 */
export function chapterSeekTargetMs(segment: OcSegment, region: ChapterClickRegion): number {
  void region
  return segment.startMs
}
