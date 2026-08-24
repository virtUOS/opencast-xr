import { describe, expect, it } from 'vitest'
import type { Cue, OcSegment } from '../opencast/types'
import {
  activeCue,
  seekFeedback,
  SEEK_FEEDBACK_CHAPTER_MAX_CHARS,
  DEFAULT_SUBTITLE_SCALE,
  MAX_SUBTITLE_SCALE,
  MIN_SUBTITLE_SCALE,
  SUBTITLE_SCALE_LABELS,
  SUBTITLE_SCALE_STEPS,
  cycleSubtitleScale,
  subtitleScaleIndex,
  subtitleScaleLabel,
} from './subtitleHudState'

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

describe('caption size steps', () => {
  it('has one label per step, and a default that is one of the steps', () => {
    expect(SUBTITLE_SCALE_LABELS).toHaveLength(SUBTITLE_SCALE_STEPS.length)
    expect(SUBTITLE_SCALE_STEPS).toContain(DEFAULT_SUBTITLE_SCALE)
  })

  it('keeps the steps strictly ascending, with MIN/MAX at the ends', () => {
    for (let i = 1; i < SUBTITLE_SCALE_STEPS.length; i++) {
      expect(SUBTITLE_SCALE_STEPS[i]).toBeGreaterThan(SUBTITLE_SCALE_STEPS[i - 1])
    }
    expect(MIN_SUBTITLE_SCALE).toBe(SUBTITLE_SCALE_STEPS[0])
    expect(MAX_SUBTITLE_SCALE).toBe(SUBTITLE_SCALE_STEPS[SUBTITLE_SCALE_STEPS.length - 1])
  })

  it('defaults well below 1: the raw uikit design size does not fit the magic window', () => {
    // Not a style preference - see SUBTITLE_SCALE_STEPS' doc comment. This is
    // the user-reported "passen nicht in das Browserfenster" regression guard:
    // a future edit that resets the default to 1.0 has to fail a test.
    expect(DEFAULT_SUBTITLE_SCALE).toBeLessThan(0.5)
    expect(MAX_SUBTITLE_SCALE).toBeLessThan(0.5)
    expect(MIN_SUBTITLE_SCALE).toBeGreaterThan(0)
  })

  it('maps each step to its own index and label', () => {
    SUBTITLE_SCALE_STEPS.forEach((step, i) => {
      expect(subtitleScaleIndex(step)).toBe(i)
      expect(subtitleScaleLabel(step)).toBe(SUBTITLE_SCALE_LABELS[i])
    })
  })

  it('snaps a value between two steps to the NEAREST one, not to step 0', () => {
    const [small, medium] = SUBTITLE_SCALE_STEPS
    expect(subtitleScaleIndex(small + (medium - small) * 0.9)).toBe(1)
    expect(subtitleScaleIndex(small + (medium - small) * 0.1)).toBe(0)
  })

  it('clamps out-of-range and non-finite values to a usable step', () => {
    expect(subtitleScaleIndex(0)).toBe(0)
    expect(subtitleScaleIndex(-5)).toBe(0)
    expect(subtitleScaleIndex(99)).toBe(SUBTITLE_SCALE_STEPS.length - 1)
    expect(subtitleScaleIndex(Number.NaN)).toBe(SUBTITLE_SCALE_STEPS.indexOf(DEFAULT_SUBTITLE_SCALE))
  })

  it('cycles forward through every step and wraps round to the smallest', () => {
    let scale = SUBTITLE_SCALE_STEPS[0]
    const seen: number[] = [scale]
    for (let i = 1; i < SUBTITLE_SCALE_STEPS.length; i++) {
      scale = cycleSubtitleScale(scale)
      seen.push(scale)
    }
    expect(seen).toEqual([...SUBTITLE_SCALE_STEPS])
    expect(cycleSubtitleScale(MAX_SUBTITLE_SCALE)).toBe(MIN_SUBTITLE_SCALE)
  })

  it('always cycles to a real step, even from a value that is not one', () => {
    expect(SUBTITLE_SCALE_STEPS).toContain(cycleSubtitleScale(0.9137))
    expect(SUBTITLE_SCALE_STEPS).toContain(cycleSubtitleScale(Number.NaN))
  })
})
