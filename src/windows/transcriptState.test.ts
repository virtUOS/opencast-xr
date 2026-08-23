import { describe, expect, it } from 'vitest'
import type { Cue } from '../opencast/types'
import {
  activeCueIndex,
  AUTO_SCROLL_SUPPRESS_MS,
  chunkCueText,
  normalizeCueText,
  shouldAutoScroll,
  transcriptRows,
} from './transcriptState'

const cues: Cue[] = [
  { startMs: 0, endMs: 2000, text: 'Hallo' },
  { startMs: 3000, endMs: 5000, text: 'Welt' },
]

describe('activeCueIndex', () => {
  it('returns -1 for an empty list', () => {
    expect(activeCueIndex([], 1000)).toBe(-1)
  })

  it('returns -1 before the first cue starts', () => {
    expect(activeCueIndex(cues, -1)).toBe(-1)
  })

  it('finds the cue containing tMs (start inclusive)', () => {
    expect(activeCueIndex(cues, 0)).toBe(0)
    expect(activeCueIndex(cues, 1500)).toBe(0)
  })

  it('excludes tMs exactly at endMs (end exclusive)', () => {
    expect(activeCueIndex(cues, 2000)).toBe(-1)
  })

  it('returns -1 in a gap between cues', () => {
    expect(activeCueIndex(cues, 2500)).toBe(-1)
  })

  it('finds the second cue', () => {
    expect(activeCueIndex(cues, 4000)).toBe(1)
  })

  it('returns -1 after the last cue ends', () => {
    expect(activeCueIndex(cues, 5000)).toBe(-1)
  })
})

describe('normalizeCueText', () => {
  it('collapses an embedded VTT line break into a single space', () => {
    expect(normalizeCueText('buch herzlich willkommen zum\nexperiment der woche bei den')).toBe(
      'buch herzlich willkommen zum experiment der woche bei den',
    )
  })

  it('collapses multiple/mixed whitespace runs into one space', () => {
    expect(normalizeCueText('a\n\nb   c\t\nd')).toBe('a b c d')
  })

  it('trims leading/trailing whitespace', () => {
    expect(normalizeCueText('  hallo welt  \n')).toBe('hallo welt')
  })

  it('leaves already-plain text unchanged', () => {
    expect(normalizeCueText('hallo welt')).toBe('hallo welt')
  })
})

describe('chunkCueText', () => {
  it('returns the text unchanged in a single chunk when it fits', () => {
    expect(chunkCueText('short', 200)).toEqual(['short'])
  })

  it('returns one chunk when length exactly equals max', () => {
    const text = 'a'.repeat(200)
    expect(chunkCueText(text, 200)).toEqual([text])
  })

  it('splits text longer than max into multiple max-sized chunks, the last one shorter', () => {
    const text = 'a'.repeat(250)
    const chunks = chunkCueText(text, 200)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(200)
    expect(chunks[1]).toHaveLength(50)
    expect(chunks.join('')).toBe(text)
  })

  it('splits an exact multiple of max into equal chunks', () => {
    const text = 'a'.repeat(400)
    const chunks = chunkCueText(text, 200)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(200)
    expect(chunks[1]).toHaveLength(200)
  })

  it('handles an empty string as one empty chunk', () => {
    expect(chunkCueText('', 200)).toEqual([''])
  })
})

describe('transcriptRows', () => {
  it('produces one row per short cue, prefixed with M:SS', () => {
    const rows = transcriptRows(cues, false)
    expect(rows).toEqual([
      { id: '0-0', cueIndex: 0, text: '0:00  Hallo' },
      { id: '1-0', cueIndex: 1, text: '0:03  Welt' },
    ])
  })

  it('renders H:MM:SS when includeHours is set', () => {
    const rows = transcriptRows([{ startMs: 3_661_000, endMs: 3_662_000, text: 'x' }], true)
    expect(rows[0].text).toBe('1:01:01  x')
  })

  it('splits a long cue into continuation rows sharing the same cueIndex, only the first prefixed', () => {
    const longText = 'a'.repeat(250)
    const rows = transcriptRows([{ startMs: 1000, endMs: 2000, text: longText }], false)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: '0-0', cueIndex: 0, text: `0:01  ${'a'.repeat(200)}` })
    expect(rows[1]).toEqual({ id: '0-1', cueIndex: 0, text: 'a'.repeat(50) })
  })

  it('returns an empty array for no cues', () => {
    expect(transcriptRows([], false)).toEqual([])
  })

  it('normalizes a real VTT cue\'s embedded line break before building the row', () => {
    const rows = transcriptRows(
      [{ startMs: 9780, endMs: 24780, text: 'buch herzlich willkommen zum\nexperiment der woche bei den' }],
      false,
    )
    expect(rows).toEqual([
      { id: '0-0', cueIndex: 0, text: '0:10  buch herzlich willkommen zum experiment der woche bei den' },
    ])
  })
})

describe('shouldAutoScroll', () => {
  it('allows it when never manually scrolled', () => {
    expect(shouldAutoScroll(-Infinity, Date.now())).toBe(true)
  })

  it('blocks it within the suppress window', () => {
    const now = 1_000_000
    expect(shouldAutoScroll(now - 1000, now)).toBe(false)
  })

  it('allows it exactly at the suppress boundary', () => {
    const now = 1_000_000
    expect(shouldAutoScroll(now - AUTO_SCROLL_SUPPRESS_MS, now)).toBe(true)
  })

  it('allows it well past the suppress window', () => {
    const now = 1_000_000
    expect(shouldAutoScroll(now - AUTO_SCROLL_SUPPRESS_MS - 1, now)).toBe(true)
  })

  it('respects a custom suppress duration', () => {
    expect(shouldAutoScroll(900, 1000, 50)).toBe(true)
    expect(shouldAutoScroll(980, 1000, 50)).toBe(false)
  })
})
