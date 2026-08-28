import { describe, expect, it } from 'vitest'
import coffeeRunFixture from '../opencast/__fixtures__/episode-coffee-run.json'
import { parseEpisodeResponse } from '../opencast/parse'
import { selectStreams } from '../opencast/selectTracks'
import type { Episode, OcTrack } from '../opencast/types'
import {
  TEST_CHAPTER_STARTS_S,
  buildTestChapters,
  buildTestLongCues,
  syntheticDualStream,
} from './syntheticDualStream'

function coffeeRun(): Episode {
  const [episode] = parseEpisodeResponse(coffeeRunFixture)
  return episode
}

function videoTrack(overrides: Partial<OcTrack>): OcTrack {
  return {
    id: 't',
    flavor: 'presenter/preview',
    flavorType: 'presenter',
    mimetype: 'video/mp4',
    url: 'https://example.org/a.mp4',
    tags: ['engage-download'],
    isVideo: true,
    isCaptions: false,
    ...overrides,
  }
}

function episodeWith(tracks: OcTrack[]): Episode {
  return { id: 'e', title: 'E', durationMs: 1000, creators: [], tracks, segments: [] }
}

describe('syntheticDualStream', () => {
  it('the real Coffee Run recording has exactly one stream to begin with', () => {
    expect(selectStreams(coffeeRun().tracks).map((s) => s.flavorType)).toEqual(['presenter'])
  })

  it('turns it into presenter + presentation over the same URL', () => {
    const streams = selectStreams(syntheticDualStream(coffeeRun()).tracks)
    expect(streams.map((s) => s.flavorType)).toEqual(['presenter', 'presentation'])
    expect(streams[0].url).toBe(streams[1].url)
    expect(streams[0].url).toBe(selectStreams(coffeeRun().tracks)[0].url)
  })

  it('keeps the chosen rendition intact (resolution, mimetype, tags) in both clones', () => {
    const original = selectStreams(coffeeRun().tracks)[0]
    for (const stream of selectStreams(syntheticDualStream(coffeeRun()).tracks)) {
      expect(stream.width).toBe(original.width)
      expect(stream.height).toBe(original.height)
    }
    for (const track of syntheticDualStream(coffeeRun()).tracks.filter((t) => t.isVideo)) {
      expect(track.mimetype).toBe('video/mp4')
      expect(track.tags).toContain('engage-download')
    }
  })

  it('gives the clones distinct ids', () => {
    const ids = syntheticDualStream(coffeeRun()).tracks.filter((t) => t.isVideo).map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves non-video tracks (captions) untouched', () => {
    const captions = videoTrack({
      id: 'c', flavor: 'captions/source+de', flavorType: 'captions',
      mimetype: 'text/vtt', url: 'https://example.org/c.vtt', isVideo: false, isCaptions: true,
    })
    const result = syntheticDualStream(episodeWith([videoTrack({}), captions]))
    expect(result.tracks.filter((t) => t.isCaptions)).toEqual([captions])
  })

  it('leaves an episode that already has two video flavors completely alone', () => {
    const ep = episodeWith([
      videoTrack({ id: 'a' }),
      videoTrack({
        id: 'b', flavor: 'presentation/preview', flavorType: 'presentation',
        url: 'https://example.org/b.mp4',
      }),
    ])
    expect(syntheticDualStream(ep)).toBe(ep)
  })

  it('leaves an episode with no playable video alone', () => {
    const ep = episodeWith([videoTrack({ tags: [] })]) // not engage-download -> not eligible
    expect(syntheticDualStream(ep)).toBe(ep)
    expect(syntheticDualStream(episodeWith([]))).toEqual(episodeWith([]))
  })

  it('replaces the other renditions of the cloned flavor rather than keeping them', () => {
    // Two qualities of the same flavor: the clones must both be the 1080p one
    // selectStreams picked, so neither window ends up on a different rendition.
    const ep = episodeWith([
      videoTrack({ id: 'low', url: 'https://example.org/low.mp4', width: 640, height: 360 }),
      videoTrack({ id: 'high', url: 'https://example.org/high.mp4', width: 1920, height: 1080 }),
    ])
    const tracks = syntheticDualStream(ep).tracks
    expect(tracks).toHaveLength(2)
    expect(tracks.map((t) => t.url)).toEqual([
      'https://example.org/high.mp4',
      'https://example.org/high.mp4',
    ])
  })
})

describe('buildTestChapters', () => {
  it('produces exactly three segments at the fixed 0/60/120s offsets', () => {
    const ep = episodeWith([videoTrack({})])
    const segments = buildTestChapters(ep)
    expect(segments.map((s) => s.startMs)).toEqual(TEST_CHAPTER_STARTS_S.map((s) => s * 1000))
  })

  it('reuses the episode\'s own previewUrl on every segment', () => {
    const ep = { ...episodeWith([videoTrack({})]), previewUrl: 'https://example.org/preview.jpg' }
    for (const segment of buildTestChapters(ep)) {
      expect(segment.previewUrl).toBe('https://example.org/preview.jpg')
    }
  })

  it('gives each segment distinct, non-empty OCR-placeholder text', () => {
    const texts = buildTestChapters(episodeWith([videoTrack({})])).map((s) => s.text)
    expect(new Set(texts).size).toBe(texts.length)
    expect(texts.every((t) => t.length > 0)).toBe(true)
  })
})

describe('buildTestLongCues', () => {
  it('produces cues long enough to wrap multiple visual lines, none overlapping in time', () => {
    const cues = buildTestLongCues()
    expect(cues.length).toBeGreaterThan(0)
    for (const cue of cues) {
      // "Long enough to wrap" per this file's own doc comment - a loose
      // floor (not a precise line-count prediction, which depends on the
      // rendered column width) that would catch an accidental swap for
      // short placeholder text.
      expect(cue.text.length).toBeGreaterThan(80)
      expect(cue.endMs).toBeGreaterThan(cue.startMs)
    }
    // Sequential, non-overlapping - see chapterSeekTarget-style consumers,
    // and activeCueIndex, which assume a cue's [startMs, endMs) range does
    // not collide with its neighbours'.
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startMs).toBeGreaterThanOrEqual(cues[i - 1].endMs)
    }
  })
})
