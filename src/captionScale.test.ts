import { describe, expect, it } from 'vitest'
import {
  CAPTION_OFFSET_STEP_DEG,
  CAPTION_SCALE_STEP,
  DEFAULT_CAPTION_OFFSET_DEG,
  DEFAULT_CAPTION_SCALE,
  MAX_CAPTION_OFFSET_DEG,
  MAX_CAPTION_SCALE,
  MIN_CAPTION_OFFSET_DEG,
  MIN_CAPTION_SCALE,
  captionScaleLabel,
  clampCaptionOffset,
  clampCaptionScale,
  stepCaptionOffset,
  stepCaptionScale,
} from './captionScale'

describe('caption size', () => {
  it('defaults well below 1: the raw uikit design size does not fit the magic window', () => {
    // Not a style preference - see captionScale.ts's doc comment. This is the
    // user-reported "passen nicht in das Browserfenster" regression guard: a
    // future edit that resets the default to 1.0 has to fail a test.
    expect(DEFAULT_CAPTION_SCALE).toBeLessThan(0.5)
    expect(MAX_CAPTION_SCALE).toBeLessThan(0.5)
    expect(MIN_CAPTION_SCALE).toBeGreaterThan(0)
    expect(MIN_CAPTION_SCALE).toBeLessThan(DEFAULT_CAPTION_SCALE)
    expect(DEFAULT_CAPTION_SCALE).toBeLessThan(MAX_CAPTION_SCALE)
  })

  it('starts BELOW the old smallest step, which the user still found too large', () => {
    // Round 2 of the Quest feedback: „L ist zu gross ... S ist gefuehlt auch
    // noch ein wenig zu gross". The old ladder was 0.18/0.24/0.32 with 0.24 the
    // default. A retune that quietly drifts back up has to fail here.
    expect(DEFAULT_CAPTION_SCALE).toBeLessThan(0.18)
    // ...and there is real room left underneath it, because that judgement was
    // made through lenses this project cannot see through and may be wrong in
    // the same direction again.
    expect(MIN_CAPTION_SCALE).toBeLessThan(DEFAULT_CAPTION_SCALE * 0.7)
  })

  it('steps by a constant RATIO, so one press feels the same at either end', () => {
    // A fixed additive step cannot serve a 3.5x range: it is a 22 % jump at the
    // small end and a 6 % nudge at the large one.
    const small = 0.1
    const large = 0.28
    expect(stepCaptionScale(small, 1) / small).toBeCloseTo(1 + CAPTION_SCALE_STEP, 10)
    expect(stepCaptionScale(large, 1) / large).toBeCloseTo(1 + CAPTION_SCALE_STEP, 10)
  })

  it('goes up and back down to where it started', () => {
    const start = DEFAULT_CAPTION_SCALE
    expect(stepCaptionScale(stepCaptionScale(start, 1), -1)).toBeCloseTo(start, 10)
  })

  it('clamps at both ends, and stepping past an end is idempotent', () => {
    expect(stepCaptionScale(MAX_CAPTION_SCALE, 1)).toBe(MAX_CAPTION_SCALE)
    expect(stepCaptionScale(MIN_CAPTION_SCALE, -1)).toBe(MIN_CAPTION_SCALE)
    expect(stepCaptionScale(99, 1)).toBe(MAX_CAPTION_SCALE)
    expect(stepCaptionScale(0.0001, -1)).toBe(MIN_CAPTION_SCALE)
  })

  it('reaches both ends of the range in a handful of presses', () => {
    // „Vielleicht mit + und - Buttons einfach einstellbar" - a ladder that
    // needs twenty presses to cross its own range is not einfach.
    let up = DEFAULT_CAPTION_SCALE
    let presses = 0
    while (up < MAX_CAPTION_SCALE && presses < 50) {
      up = stepCaptionScale(up, 1)
      presses++
    }
    expect(presses).toBeLessThanOrEqual(10)

    let down = DEFAULT_CAPTION_SCALE
    presses = 0
    while (down > MIN_CAPTION_SCALE && presses < 50) {
      down = stepCaptionScale(down, -1)
      presses++
    }
    expect(presses).toBeLessThanOrEqual(10)
  })

  it('treats any positive/negative direction as one step of that sign', () => {
    expect(stepCaptionScale(0.2, 5)).toBe(stepCaptionScale(0.2, 1))
    expect(stepCaptionScale(0.2, -5)).toBe(stepCaptionScale(0.2, -1))
    // 0 counts as "up": a caller passing a falsy direction gets a defined,
    // in-range result rather than a surprise.
    expect(stepCaptionScale(0.2, 0)).toBe(stepCaptionScale(0.2, 1))
  })

  it('never lets a NaN out - a NaN caption scale makes the caption silently vanish', () => {
    expect(stepCaptionScale(Number.NaN, 1)).toBe(DEFAULT_CAPTION_SCALE)
    expect(stepCaptionScale(Number.POSITIVE_INFINITY, -1)).toBe(DEFAULT_CAPTION_SCALE)
    expect(clampCaptionScale(Number.NaN)).toBe(DEFAULT_CAPTION_SCALE)
  })

  it('clamps a stored or legacy value into the current range', () => {
    // A scale saved by an earlier build (the old ladder went to 0.32 and
    // started at 0.18) must land somewhere usable, not be rejected.
    expect(clampCaptionScale(0.18)).toBe(0.18)
    expect(clampCaptionScale(0.4)).toBe(MAX_CAPTION_SCALE)
    expect(clampCaptionScale(0.01)).toBe(MIN_CAPTION_SCALE)
  })
})

describe('captionScaleLabel', () => {
  it('reads as a percentage of the default size', () => {
    expect(captionScaleLabel(DEFAULT_CAPTION_SCALE)).toBe('100%')
    expect(captionScaleLabel(DEFAULT_CAPTION_SCALE * 2)).toBe('200%')
    expect(captionScaleLabel(DEFAULT_CAPTION_SCALE / 2)).toBe('50%')
  })

  it('changes on every single press, so the readout is never a dead number', () => {
    let scale = MIN_CAPTION_SCALE
    let previous = captionScaleLabel(scale)
    for (let i = 0; i < 12 && scale < MAX_CAPTION_SCALE; i++) {
      scale = stepCaptionScale(scale, 1)
      const label = captionScaleLabel(scale)
      expect(label).not.toBe(previous)
      previous = label
    }
  })

  it('is plain ASCII', () => {
    // docs/UIKIT-NOTES.md entry 3: typographic punctuation renders as a tofu
    // box in this uikit version's default font.
    for (const scale of [MIN_CAPTION_SCALE, DEFAULT_CAPTION_SCALE, MAX_CAPTION_SCALE, Number.NaN]) {
      expect(captionScaleLabel(scale)).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})

describe('caption vertical offset', () => {
  it('starts at the HUD\'s own resting pitch', () => {
    expect(DEFAULT_CAPTION_OFFSET_DEG).toBe(0)
    expect(MIN_CAPTION_OFFSET_DEG).toBe(-MAX_CAPTION_OFFSET_DEG)
  })

  it('moves up for +1 and down for -1', () => {
    // Positive = up, because that is how the dock's up/down buttons read.
    expect(stepCaptionOffset(0, 1)).toBe(CAPTION_OFFSET_STEP_DEG)
    expect(stepCaptionOffset(0, -1)).toBe(-CAPTION_OFFSET_STEP_DEG)
  })

  it('clamps at both ends, and stepping past an end is idempotent', () => {
    expect(stepCaptionOffset(MAX_CAPTION_OFFSET_DEG, 1)).toBe(MAX_CAPTION_OFFSET_DEG)
    expect(stepCaptionOffset(MIN_CAPTION_OFFSET_DEG, -1)).toBe(MIN_CAPTION_OFFSET_DEG)
    expect(clampCaptionOffset(90)).toBe(MAX_CAPTION_OFFSET_DEG)
    expect(clampCaptionOffset(-90)).toBe(MIN_CAPTION_OFFSET_DEG)
  })

  it('keeps the caption clear of the video above and the dock below', () => {
    // The HUD rests 15 degrees below gaze (sphere-shell's
    // DEFAULT_HEADLOCKED.offsetPitchDeg) and the dock sits at -30. Nudging all
    // the way up must not put the caption on the video it captions, and all the
    // way down must not bury it in the dock.
    const restingPitch = -15
    const dockElevation = -30
    expect(restingPitch + MAX_CAPTION_OFFSET_DEG).toBeLessThan(0)
    expect(restingPitch + MIN_CAPTION_OFFSET_DEG).toBeGreaterThan(dockElevation)
  })

  it('reaches both ends in a handful of presses', () => {
    expect(MAX_CAPTION_OFFSET_DEG / CAPTION_OFFSET_STEP_DEG).toBeLessThanOrEqual(6)
  })

  it('never lets a NaN out - a NaN pitch puts the HUD nowhere at all', () => {
    expect(stepCaptionOffset(Number.NaN, 1)).toBe(DEFAULT_CAPTION_OFFSET_DEG)
    expect(clampCaptionOffset(Number.NaN)).toBe(DEFAULT_CAPTION_OFFSET_DEG)
  })
})
