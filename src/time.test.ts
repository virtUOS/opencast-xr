import { describe, expect, it } from 'vitest'
import { formatDuration, formatTimestamp, splitSeconds } from './time'

describe('splitSeconds', () => {
  it('splits and rounds to the nearest whole second', () => {
    expect(splitSeconds(3725.6)).toEqual({ h: 1, m: 2, s: 6 })
  })

  it('clamps a negative or tiny-overshoot input to zero rather than going negative', () => {
    expect(splitSeconds(-0.2)).toEqual({ h: 0, m: 0, s: 0 })
  })
})

describe('formatDuration (H:MM:SS, unpadded hours, re-exported for windows/libraryState.ts)', () => {
  it('always includes the hour component, even at 0', () => {
    expect(formatDuration(5_000)).toBe('0:00:05')
  })

  it('formats past an hour', () => {
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })

  it('matches Coffee Run\'s real duration (184629 ms)', () => {
    expect(formatDuration(184_629)).toBe('0:03:05')
  })
})

describe('formatTimestamp (M:SS or H:MM:SS by caller choice)', () => {
  it('renders M:SS with no hour digit when includeHours is false', () => {
    expect(formatTimestamp(185, false)).toBe('3:05')
  })

  it('folds hours into the minute count when includeHours is false, even past 60 minutes', () => {
    expect(formatTimestamp(3_725, false)).toBe('62:05')
  })

  it('renders H:MM:SS when includeHours is true, matching formatDuration\'s shape', () => {
    expect(formatTimestamp(3_725, true)).toBe('1:02:05')
  })

  it('agrees with formatDuration for the same underlying seconds when includeHours is true', () => {
    const ms = 184_629
    expect(formatTimestamp(ms / 1000, true)).toBe(formatDuration(ms))
  })
})
