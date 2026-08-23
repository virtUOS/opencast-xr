import { describe, expect, it } from 'vitest'
import {
  clampFraction,
  derivePlaybackVisualState,
  fractionToSeconds,
  secondsToFraction,
  stepVolume,
  transportTimeLabel,
  transportTimeParts,
  volumeToPercent,
} from './transportState'

describe('clampFraction', () => {
  it('passes values already in [0,1] through unchanged', () => {
    expect(clampFraction(0.42)).toBe(0.42)
  })

  it('clamps below 0 and above 1', () => {
    expect(clampFraction(-0.5)).toBe(0)
    expect(clampFraction(1.5)).toBe(1)
  })

  it('treats a non-finite input as 0 rather than propagating NaN', () => {
    expect(clampFraction(NaN)).toBe(0)
    expect(clampFraction(Infinity)).toBe(0)
  })
})

describe('fractionToSeconds / secondsToFraction (the slider drag <-> playback-time mapping)', () => {
  it('map a mid-track fraction to the proportional time and back', () => {
    expect(fractionToSeconds(0.5, 200)).toBe(100)
    expect(secondsToFraction(100, 200)).toBe(0.5)
  })

  it('clamp an out-of-range fraction before scaling', () => {
    expect(fractionToSeconds(-0.2, 200)).toBe(0)
    expect(fractionToSeconds(1.2, 200)).toBe(200)
  })

  it('clamp an out-of-range time before dividing', () => {
    expect(secondsToFraction(-5, 200)).toBe(0)
    expect(secondsToFraction(500, 200)).toBe(1)
  })

  it('never divides by a zero or negative duration (no episode yet, or a malformed one)', () => {
    expect(fractionToSeconds(0.5, 0)).toBe(0)
    expect(fractionToSeconds(0.5, -10)).toBe(0)
    expect(secondsToFraction(50, 0)).toBe(0)
    expect(secondsToFraction(50, -10)).toBe(0)
  })
})

describe('transportTimeLabel', () => {
  it('renders both sides as M:SS under an hour', () => {
    expect(transportTimeLabel(65, 464)).toBe('1:05 / 7:44')
  })

  it('renders both sides as H:MM:SS once the episode is >=1h, even while currentS itself is still under an hour', () => {
    expect(transportTimeLabel(65, 3_725)).toBe('0:01:05 / 1:02:05')
  })
})

describe('transportTimeParts', () => {
  it('matches the joined transportTimeLabel, split into current/total', () => {
    expect(transportTimeParts(65, 464)).toEqual({ current: '1:05', total: '7:44' })
    expect(transportTimeParts(65, 3_725)).toEqual({ current: '0:01:05', total: '1:02:05' })
  })
})

describe('derivePlaybackVisualState', () => {
  it('shows "play" whenever intent is not playing, stalled or not', () => {
    expect(derivePlaybackVisualState(false, false)).toBe('play')
    expect(derivePlaybackVisualState(false, true)).toBe('play')
  })

  it('shows "pause" when intent is playing and nothing is stalled', () => {
    expect(derivePlaybackVisualState(true, false)).toBe('pause')
  })

  it('shows "loading" when intent is playing but the engine is stalled', () => {
    expect(derivePlaybackVisualState(true, true)).toBe('loading')
  })
})

describe('stepVolume', () => {
  it('steps up and down by exactly 0.1 with no float drift', () => {
    expect(stepVolume(0.5, 1)).toBe(0.6)
    expect(stepVolume(0.5, -1)).toBe(0.4)
    expect(stepVolume(0.3, -1)).toBe(0.2) // 0.3 - 0.1 is 0.19999999999999998 in raw float
  })

  it('clamps at 1 and does not overshoot', () => {
    expect(stepVolume(1, 1)).toBe(1)
    expect(stepVolume(0.95, 1)).toBe(1)
  })

  it('clamps at 0 and does not undershoot', () => {
    expect(stepVolume(0, -1)).toBe(0)
    expect(stepVolume(0.05, -1)).toBe(0)
  })
})

describe('volumeToPercent', () => {
  it('converts a 0-1 volume to a whole-number percentage', () => {
    expect(volumeToPercent(1)).toBe(100)
    expect(volumeToPercent(0.7)).toBe(70)
    expect(volumeToPercent(0)).toBe(0)
  })

  it('clamps out-of-range input the same way clampFraction does', () => {
    expect(volumeToPercent(1.5)).toBe(100)
    expect(volumeToPercent(-0.5)).toBe(0)
  })
})
