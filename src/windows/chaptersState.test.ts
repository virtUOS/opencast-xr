import { describe, expect, it } from 'vitest'
import type { OcSegment } from '../opencast/types'
import { OCR_MAX_CHARS, activeSegmentIndex, segmentTile, segmentTiles, truncateOcrText } from './chaptersState'

function seg(overrides: Partial<OcSegment> = {}): OcSegment {
  return { startMs: 0, durationMs: 60_000, text: 'Slide text', previewUrl: undefined, ...overrides }
}

describe('truncateOcrText', () => {
  it('leaves text at or under the limit untouched', () => {
    const text = 'a'.repeat(OCR_MAX_CHARS)
    expect(truncateOcrText(text)).toBe(text)
  })

  it('truncates text over the limit to exactly the limit, with a "..." suffix', () => {
    const text = 'a'.repeat(OCR_MAX_CHARS + 10)
    const result = truncateOcrText(text)
    expect(result).toHaveLength(OCR_MAX_CHARS)
    expect(result.endsWith('...')).toBe(true)
    expect(result.slice(0, OCR_MAX_CHARS - 3)).toBe('a'.repeat(OCR_MAX_CHARS - 3))
  })

  it('honours a custom max', () => {
    expect(truncateOcrText('abcdefgh', 5)).toBe('ab...')
  })
})

describe('segmentTile', () => {
  it('maps startMs/text/previewUrl to subtitle/title/imageUrl', () => {
    const tile = segmentTile(seg({ startMs: 65_000, text: 'Hello', previewUrl: 'https://x/y.jpg' }), 2, false)
    expect(tile).toEqual({ id: '2', title: 'Hello', subtitle: '1:05', imageUrl: 'https://x/y.jpg' })
  })

  it('truncates long OCR text to OCR_MAX_CHARS', () => {
    const longText = 'x'.repeat(OCR_MAX_CHARS + 5)
    const tile = segmentTile(seg({ text: longText }), 0, false)
    expect(tile.title).toHaveLength(OCR_MAX_CHARS)
  })

  it('includes the hour digit when told to', () => {
    const tile = segmentTile(seg({ startMs: 3_665_000 }), 0, true)
    expect(tile.subtitle).toBe('1:01:05')
  })
})

describe('segmentTiles', () => {
  it('picks includeHours from the episode duration, applied to every tile', () => {
    const segments = [seg({ startMs: 0 }), seg({ startMs: 3_700_000 })]
    const tiles = segmentTiles(segments, 3_600_000) // exactly 1h -> includeHours
    expect(tiles[0].subtitle).toBe('0:00:00')
    expect(tiles[1].subtitle).toBe('1:01:40')
  })

  it('uses the short M:SS shape under an hour', () => {
    const tiles = segmentTiles([seg({ startMs: 5_000 })], 599_999)
    expect(tiles[0].subtitle).toBe('0:05')
  })

  it('ids are the index, stringified, in order', () => {
    const tiles = segmentTiles([seg(), seg(), seg()], 0)
    expect(tiles.map((t) => t.id)).toEqual(['0', '1', '2'])
  })
})

describe('activeSegmentIndex', () => {
  const segments = [seg({ startMs: 0 }), seg({ startMs: 60_000 }), seg({ startMs: 120_000 })]

  it('returns -1 for an empty list', () => {
    expect(activeSegmentIndex([], 30)).toBe(-1)
  })

  it('picks segment 0 for a time within its range', () => {
    expect(activeSegmentIndex(segments, 30)).toBe(0)
  })

  it('is still segment 0 exactly one tick before the second boundary', () => {
    expect(activeSegmentIndex(segments, 59.999)).toBe(0)
  })

  it('flips to segment 1 exactly at the second boundary', () => {
    expect(activeSegmentIndex(segments, 60)).toBe(1)
  })

  it('stays on the last segment all the way to (and past) the episode end - no reliable end bound', () => {
    expect(activeSegmentIndex(segments, 179)).toBe(2)
    expect(activeSegmentIndex(segments, 10_000)).toBe(2)
  })

  it('returns -1 when currentTimeS precedes every segment start', () => {
    expect(activeSegmentIndex([seg({ startMs: 10_000 })], 5)).toBe(-1)
  })

  it('is robust to unsorted input', () => {
    const shuffled = [seg({ startMs: 120_000 }), seg({ startMs: 0 }), seg({ startMs: 60_000 })]
    expect(activeSegmentIndex(shuffled, 90)).toBe(2) // the 60_000 entry, at index 2 of the shuffled array
  })
})
