import { describe, expect, it } from 'vitest'
import {
  CAPTION_SCALE_LABELS,
  CAPTION_SCALE_STEPS,
  DEFAULT_CAPTION_SCALE,
  MAX_CAPTION_SCALE,
  MIN_CAPTION_SCALE,
  captionScaleIndex,
  captionScaleLabel,
  cycleCaptionScale,
} from './captionScale'

describe('caption size steps', () => {
  it('has one label per step, and a default that is one of the steps', () => {
    expect(CAPTION_SCALE_LABELS).toHaveLength(CAPTION_SCALE_STEPS.length)
    expect(CAPTION_SCALE_STEPS).toContain(DEFAULT_CAPTION_SCALE)
  })

  it('keeps the steps strictly ascending, with MIN/MAX at the ends', () => {
    for (let i = 1; i < CAPTION_SCALE_STEPS.length; i++) {
      expect(CAPTION_SCALE_STEPS[i]).toBeGreaterThan(CAPTION_SCALE_STEPS[i - 1])
    }
    expect(MIN_CAPTION_SCALE).toBe(CAPTION_SCALE_STEPS[0])
    expect(MAX_CAPTION_SCALE).toBe(CAPTION_SCALE_STEPS[CAPTION_SCALE_STEPS.length - 1])
  })

  it('defaults well below 1: the raw uikit design size does not fit the magic window', () => {
    // Not a style preference - see CAPTION_SCALE_STEPS' doc comment. This is
    // the user-reported "passen nicht in das Browserfenster" regression guard:
    // a future edit that resets the default to 1.0 has to fail a test.
    expect(DEFAULT_CAPTION_SCALE).toBeLessThan(0.5)
    expect(MAX_CAPTION_SCALE).toBeLessThan(0.5)
    expect(MIN_CAPTION_SCALE).toBeGreaterThan(0)
  })

  it('maps each step to its own index and label', () => {
    CAPTION_SCALE_STEPS.forEach((step, i) => {
      expect(captionScaleIndex(step)).toBe(i)
      expect(captionScaleLabel(step)).toBe(CAPTION_SCALE_LABELS[i])
    })
  })

  it('snaps a value between two steps to the NEAREST one, not to step 0', () => {
    const [small, medium] = CAPTION_SCALE_STEPS
    expect(captionScaleIndex(small + (medium - small) * 0.9)).toBe(1)
    expect(captionScaleIndex(small + (medium - small) * 0.1)).toBe(0)
  })

  it('clamps out-of-range and non-finite values to a usable step', () => {
    expect(captionScaleIndex(0)).toBe(0)
    expect(captionScaleIndex(-5)).toBe(0)
    expect(captionScaleIndex(99)).toBe(CAPTION_SCALE_STEPS.length - 1)
    expect(captionScaleIndex(Number.NaN)).toBe(CAPTION_SCALE_STEPS.indexOf(DEFAULT_CAPTION_SCALE))
  })

  it('cycles forward through every step and wraps round to the smallest', () => {
    let scale = CAPTION_SCALE_STEPS[0]
    const seen: number[] = [scale]
    for (let i = 1; i < CAPTION_SCALE_STEPS.length; i++) {
      scale = cycleCaptionScale(scale)
      seen.push(scale)
    }
    expect(seen).toEqual([...CAPTION_SCALE_STEPS])
    expect(cycleCaptionScale(MAX_CAPTION_SCALE)).toBe(MIN_CAPTION_SCALE)
  })

  it('always cycles to a real step, even from a value that is not one', () => {
    expect(CAPTION_SCALE_STEPS).toContain(cycleCaptionScale(0.9137))
    expect(CAPTION_SCALE_STEPS).toContain(cycleCaptionScale(Number.NaN))
  })
})
