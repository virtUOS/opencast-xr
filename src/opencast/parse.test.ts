import { describe, expect, it } from 'vitest'
import episodesListFixture from './__fixtures__/episodes-list.json'
import captionsEpisodeFixture from './__fixtures__/captions-episode.json'
import seriesListFixture from './__fixtures__/series-list.json'
import { asArray, parseEpisodeResponse, parseSeriesResponse } from './parse'

describe('asArray', () => {
  it('wraps a bare object in a single-element array', () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }])
  })

  it('passes an array through unchanged', () => {
    const arr = [{ a: 1 }, { a: 2 }]
    expect(asArray(arr)).toBe(arr)
  })

  it('returns an empty array for undefined and null', () => {
    expect(asArray(undefined)).toEqual([])
    expect(asArray(null)).toEqual([])
  })
})

describe('parseEpisodeResponse', () => {
  it('parses the real episodes-list.json fixture into 10 episodes', () => {
    const episodes = parseEpisodeResponse(episodesListFixture)
    expect(episodes).toHaveLength(10)
  })

  it('parses the Coffee Run episode (first entry) with correct fields', () => {
    const [coffeeRun] = parseEpisodeResponse(episodesListFixture)

    expect(coffeeRun.id).toBe('ID-coffee-run')
    expect(coffeeRun.seriesId).toBe('ID-blender-foundation')
    expect(coffeeRun.durationMs).toBe(184629)

    // Coffee Run's media.track is a bare OBJECT (single-track episode),
    // exactly the case asArray exists to normalize.
    expect(coffeeRun.tracks).toHaveLength(1)
    const [track] = coffeeRun.tracks
    expect(track.flavor).toBe('presenter/preview')
    expect(track.flavorType).toBe('presenter')
    expect(track.tags).toContain('engage-download')
    expect(track.width).toBe(1920)
    expect(track.isVideo).toBe(true)
    expect(track.isCaptions).toBe(false)

    // previewUrl should prefer the "*/search+preview" attachment.
    expect(coffeeRun.previewUrl).toMatch(/\.(jpe?g|png|gif|webp)$/i)
  })

  it('parses the captions fixture: media.track is an ARRAY (two tracks)', () => {
    const [episode] = parseEpisodeResponse(captionsEpisodeFixture)

    // media.track here is an array (captions track + presenter track) -
    // the other half of the object-or-array duality asArray normalizes.
    expect(episode.tracks.length).toBeGreaterThanOrEqual(2)

    const captionsTrack = episode.tracks.find((t) => t.isCaptions)
    expect(captionsTrack).toBeDefined()
    expect(captionsTrack?.isCaptions).toBe(true)
    expect(captionsTrack?.isVideo).toBe(false)
    expect(captionsTrack?.flavor).toBe('captions/source+en')

    const videoTrack = episode.tracks.find((t) => t.isVideo)
    expect(videoTrack).toBeDefined()
    expect(videoTrack?.isCaptions).toBe(false)
  })

  it('tolerates a single-hit response where "result" is a bare object, not an array', () => {
    // Real Opencast search responses return a bare object (not a one-element
    // array) for "result" when there is exactly one hit. Construct that shape
    // here by lifting the Coffee Run entry out of the list fixture's array.
    const [coffeeRunEntry] = (episodesListFixture as { result: unknown[] }).result
    const singleHitResponse = { result: coffeeRunEntry, total: 1, offset: 0, limit: 20 }

    const episodes = parseEpisodeResponse(singleHitResponse)

    expect(episodes).toHaveLength(1)
    expect(episodes[0].id).toBe('ID-coffee-run')
  })

  it('tolerates a missing "result" field by returning an empty array', () => {
    expect(parseEpisodeResponse({})).toEqual([])
    expect(parseEpisodeResponse(null)).toEqual([])
  })

  it('maps segments.segment to OcSegment[]', () => {
    // Shape of a search-index segment entry, per Opencast's search
    // "segments" field on an episode search result:
    // https://docs.opencast.org/develop/developer/#!/search.json/episodeGet
    // Each <segment time="..." duration="..."><text>...</text>
    // <previews><preview>...</preview></previews></segment> becomes, once
    // the XML->JSON serializer runs, an object of the shape below. This
    // constructed fixture (not a recorded one) is what DEFINES that
    // contract for OcSegment - there is no recorded segments fixture.
    const segmentsFixture = {
      result: {
        mediapackage: {
          id: 'ID-segments-demo',
          title: 'Segments demo',
          duration: 10000,
        },
        segments: {
          segment: [
            {
              time: '0',
              duration: '5000',
              text: 'Intro',
              previews: { preview: { $: 'https://example.org/seg-0.jpg' } },
            },
            {
              time: '5000',
              duration: '5000',
              text: 'Outro',
              previews: { preview: { $: 'https://example.org/seg-1.jpg' } },
            },
          ],
        },
      },
    }

    const [episode] = parseEpisodeResponse(segmentsFixture)

    expect(episode.segments).toEqual([
      { startMs: 0, durationMs: 5000, text: 'Intro', previewUrl: 'https://example.org/seg-0.jpg' },
      { startMs: 5000, durationMs: 5000, text: 'Outro', previewUrl: 'https://example.org/seg-1.jpg' },
    ])
  })
})

describe('parseSeriesResponse', () => {
  it('parses the real series-list.json fixture', () => {
    const series = parseSeriesResponse(seriesListFixture)
    expect(series.length).toBeGreaterThan(0)

    const blenderFoundation = series.find((s) => s.id === 'ID-blender-foundation')
    expect(blenderFoundation).toBeDefined()
    expect(blenderFoundation?.title).toBe('Blender Foundation Productions')
  })
})
