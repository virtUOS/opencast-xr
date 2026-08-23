import { describe, expect, it } from 'vitest'
import chaosVtt from './__fixtures__/captions-was-ist-chaos.vtt?raw'
import { parseVtt } from './vtt'

describe('parseVtt', () => {
  it('parses the real recorded VTT into cues with valid, increasing times and non-empty text', () => {
    const cues = parseVtt(chaosVtt)

    expect(cues.length).toBeGreaterThan(0)

    for (const cue of cues) {
      expect(cue.startMs).toBeGreaterThanOrEqual(0)
      expect(cue.endMs).toBeGreaterThan(cue.startMs)
      expect(cue.text.length).toBeGreaterThan(0)
    }

    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startMs).toBeGreaterThan(cues[i - 1].startMs)
    }
  })

  it('parses identifiers, a NOTE block, MM:SS.mmm stamps, a <v Speaker> tag, and CRLF line endings', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE',
      'This is a note block that must be skipped entirely.',
      '',
      '1',
      '00:09.780 --> 00:24.780',
      '<v Speaker>buch herzlich willkommen zum',
      'experiment der woche bei den',
      '',
      'cue-2',
      '00:24.780 --> 00:27.900',
      'begriffen chaos oder chaos forschung',
      '',
    ].join('\r\n')

    const cues = parseVtt(vtt)

    expect(cues).toEqual([
      { startMs: 9780, endMs: 24780, text: 'buch herzlich willkommen zum\nexperiment der woche bei den' },
      { startMs: 24780, endMs: 27900, text: 'begriffen chaos oder chaos forschung' },
    ])
  })

  it('returns [] for garbage, non-VTT input instead of throwing', () => {
    expect(parseVtt('this is not a vtt file at all\njust some random text')).toEqual([])
    expect(parseVtt('')).toEqual([])
  })
})
