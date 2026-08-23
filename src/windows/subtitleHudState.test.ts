import { describe, expect, it } from 'vitest'
import type { Cue, OcSegment } from '../opencast/types'
import { activeCue, seekFeedback, SEEK_FEEDBACK_CHAPTER_MAX_CHARS } from './subtitleHudState'

const cues: Cue[] = [
  { startMs: 0, endMs: 2000, text: 'Hallo' },
  { startMs: 2000, endMs: 4000, text: 'Welt' },
]

describe('activeCue', () => {
  it('returns null for an empty cue list', () => {
    expect(activeCue([], 1000)).toBeNull()
  })

  it('returns the cue whose range contains tMs', () => {
    expect(activeCue(cues, 500)).toEqual(cues[0])
    expect(activeCue(cues, 2500)).toEqual(cues[1])
  })

  it('returns null in a gap or past the end', () => {
    expect(activeCue(cues, 5000)).toBeNull()
  })
})

describe('seekFeedback', () => {
  it('returns null while there is no preview in progress', () => {
    expect(seekFeedback([], null, 600_000)).toBeNull()
  })

  it('formats M:SS under an hour with no chapter title when there are no segments', () => {
    expect(seekFeedback([], 90, 600_000)).toEqual({ timeLabel: '1:30', chapterTitle: null })
  })

  it('formats H:MM:SS once the episode is >= 1h', () => {
    expect(seekFeedback([], 3700, 3_700_000)).toEqual({ timeLabel: '1:01:40', chapterTitle: null })
  })

  it('includes the chapter title covering the preview position, via chaptersState.activeSegmentIndex', () => {
    const segments: OcSegment[] = [
      { startMs: 0, durationMs: 60_000, text: 'Intro' },
      { startMs: 60_000, durationMs: 60_000, text: 'Kapitel 2 (Test)' },
    ]
    expect(seekFeedback(segments, 90, 600_000)).toEqual({ timeLabel: '1:30', chapterTitle: 'Kapitel 2 (Test)' })
    expect(seekFeedback(segments, 30, 600_000)).toEqual({ timeLabel: '0:30', chapterTitle: 'Intro' })
  })

  it('returns a null chapterTitle when previewS precedes every segment', () => {
    const segments: OcSegment[] = [{ startMs: 10_000, durationMs: 60_000, text: 'Later' }]
    expect(seekFeedback(segments, 1, 600_000)).toEqual({ timeLabel: '0:01', chapterTitle: null })
  })

  it('truncates a long chapter title to SEEK_FEEDBACK_CHAPTER_MAX_CHARS', () => {
    const longTitle = 'x'.repeat(SEEK_FEEDBACK_CHAPTER_MAX_CHARS + 40)
    const segments: OcSegment[] = [{ startMs: 0, durationMs: 60_000, text: longTitle }]
    const feedback = seekFeedback(segments, 5, 600_000)
    expect(feedback?.chapterTitle).toHaveLength(SEEK_FEEDBACK_CHAPTER_MAX_CHARS)
    expect(feedback?.chapterTitle?.endsWith('...')).toBe(true)
  })
})
