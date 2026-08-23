import type { Cue } from '../opencast/types'
import { formatTimestamp } from '../time'

/**
 * The pure, unit-tested logic behind `TranscriptWindow.tsx` - which cue is
 * active right now, how a cue's text is split into short, one-per-line
 * "rows" (the uikit wrapped-line rule, see below), and whether an
 * auto-scroll is currently allowed - kept out of the uikit component for the
 * same reason `chaptersState.ts`/`libraryState.ts` are split from their
 * windows: uikit can't render meaningfully in jsdom, so anything worth a
 * unit test has to live somewhere a test CAN reach.
 */

/**
 * Index of the cue whose `[startMs, endMs)` range contains `tMs`, or -1 if
 * none does (a gap between cues - real VTT captions are NOT guaranteed
 * contiguous - or before the first/after the last). Unlike
 * `chaptersState.ts`'s `activeSegmentIndex`, a `Cue` carries its own
 * `endMs`, so a plain range test is both correct and simpler than that
 * function's "latest segment that has started" fallback (which exists
 * specifically because `OcSegment` has no reliable end bound).
 */
export function activeCueIndex(cues: Cue[], tMs: number): number {
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    if (tMs >= cue.startMs && tMs < cue.endMs) return i
  }
  return -1
}

/**
 * Real VTT captions carry their OWN embedded line breaks (`\n`) - a hint for
 * how the ORIGINAL two-line caption rendering wrapped, not a semantic split
 * (confirmed live against develop.opencast.org's "Was ist Chaos?": every one
 * of its 29 cues' `text` contains at least one literal `\n`, e.g.
 * `"buch herzlich willkommen zum\nexperiment der woche bei den"`). Left
 * as-is, each embedded `\n` is one more forced visual line - on top of
 * whatever width-based wrapping this window's own layout adds - stacking
 * toward `docs/UIKIT-NOTES.md` entry 2's cumulative-wrapped-line defect much
 * faster than the cue's own character count would suggest. Collapsing every
 * run of whitespace (embedded newlines included) to a single space is also
 * simply better reading for a continuous transcript, independent of the
 * defect.
 */
export function normalizeCueText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * How long a single uikit `<Text>` block's own string is allowed to be
 * before it gets split into multiple "continuation" blocks for the SAME
 * cue. Real captions are short (a spoken line or two, well under this); this
 * only fires for an unusually long cue. Splitting - rather than truncating
 * away the excess the way `chaptersState.ts`'s OCR text or `MediaList.tsx`'s
 * tile titles do - keeps every word of the transcript reachable, at the cost
 * of a cue occasionally spanning more than one row (still highlighted/
 * clickable together via `TranscriptRow.cueIndex`).
 */
export const CONTINUATION_CHUNK_CHARS = 200

/** Splits `text` into chunks of at most `max` characters each - `[text]` unchanged when it already fits in one. */
export function chunkCueText(text: string, max: number = CONTINUATION_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max))
  }
  return chunks
}

export interface TranscriptRow {
  /** Stable within one `transcriptRows` call - `${cueIndex}-${chunkIndex}`. */
  id: string
  /** Which cue this row belongs to - shared across every continuation row of a long cue, for highlight/click-to-seek. */
  cueIndex: number
  /** This row's own renderable text - the FIRST chunk of a cue is prefixed with its `M:SS`/`H:MM:SS` timestamp; continuation chunks are plain text. */
  text: string
}

/**
 * Every cue as one-or-more `TranscriptRow`s, in order. `includeHours` is
 * picked once for the whole transcript from the episode's total duration
 * (>=1h), mirroring `chaptersState.ts`'s `segmentTiles` - every timestamp
 * renders in the SAME shape.
 */
export function transcriptRows(cues: Cue[], includeHours: boolean): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  cues.forEach((cue, cueIndex) => {
    const chunks = chunkCueText(normalizeCueText(cue.text))
    chunks.forEach((chunk, chunkIndex) => {
      const prefix = chunkIndex === 0 ? `${formatTimestamp(cue.startMs / 1000, includeHours)}  ` : ''
      rows.push({ id: `${cueIndex}-${chunkIndex}`, cueIndex, text: `${prefix}${chunk}` })
    })
  })
  return rows
}

/** Default: how long since the user's last manual scroll before auto-scroll is allowed to act again. */
export const AUTO_SCROLL_SUPPRESS_MS = 5000

/**
 * Whether an auto-scroll-to-active-cue is currently allowed - true unless
 * the user manually scrolled the transcript within the last `suppressMs`.
 * `lastManualScrollAtMs` is `-Infinity` (never scrolled) by convention, which
 * this happily treats as "long enough ago" without a separate null check.
 */
export function shouldAutoScroll(
  lastManualScrollAtMs: number,
  nowMs: number,
  suppressMs: number = AUTO_SCROLL_SUPPRESS_MS,
): boolean {
  return nowMs - lastManualScrollAtMs >= suppressMs
}
