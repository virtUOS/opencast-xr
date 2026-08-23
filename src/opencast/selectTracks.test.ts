import { describe, expect, it } from 'vitest'
import episodeCoffeeRunFixture from './__fixtures__/episode-coffee-run.json'
import captionsEpisodeFixture from './__fixtures__/captions-episode.json'
import { parseEpisodeResponse } from './parse'
import { findCaptionsTrack, selectStreams } from './selectTracks'
import type { OcTrack } from './types'

/**
 * Terse builder for constructed OcTrack fixtures. Defaults describe an
 * eligible engage-download video/mp4 track; override only what a test cares
 * about. `flavorType` and `isCaptions` are derived from `flavor` unless
 * explicitly overridden, matching parse.ts's own derivation rules.
 */
function mkTrack(overrides: Partial<OcTrack> = {}): OcTrack {
  const flavor = overrides.flavor ?? 'presenter/preview'
  return {
    id: overrides.id ?? `track-${flavor}-${overrides.height ?? 'unspecified'}`,
    flavor,
    flavorType: overrides.flavorType ?? flavor.split('/')[0]?.toLowerCase() ?? '',
    mimetype: overrides.mimetype ?? 'video/mp4',
    url: overrides.url ?? `https://example.org/${flavor.replace('/', '-')}-${overrides.height ?? 'na'}.mp4`,
    tags: overrides.tags ?? ['engage-download'],
    width: overrides.width,
    height: overrides.height,
    isVideo: overrides.isVideo ?? true,
    isCaptions: overrides.isCaptions ?? flavor.startsWith('captions/'),
  }
}

describe('selectStreams', () => {
  it('(a) returns one stream per flavor, ordered presenter, presentation, then the rest alphabetically', () => {
    // Flavors deliberately NOT inserted in preferred order, and "audience"
    // is an arbitrary operator-typed name - selectStreams must not special
    // case anything beyond "presenter" and "presentation".
    const tracks = [
      mkTrack({ flavor: 'audience/whatever-the-operator-typed', height: 720, width: 1280 }),
      mkTrack({ flavor: 'presentation/delivery', height: 720, width: 1280 }),
      mkTrack({ flavor: 'presenter/preview', height: 720, width: 1280 }),
    ]

    const streams = selectStreams(tracks)

    expect(streams.map((s) => s.flavorType)).toEqual(['presenter', 'presentation', 'audience'])
  })

  it('(b1) within one flavor, picks the highest resolution at or below the 1080 cap', () => {
    const tracks = [
      mkTrack({ height: 2160, width: 3840 }),
      mkTrack({ height: 1080, width: 1920 }),
      mkTrack({ height: 720, width: 1280 }),
    ]

    const [stream] = selectStreams(tracks)

    expect(stream.height).toBe(1080)
  })

  it('(b2) when every quality is above the cap, picks the smallest one above it', () => {
    const tracks = [mkTrack({ height: 2160, width: 3840 }), mkTrack({ height: 1440, width: 2560 })]

    const [stream] = selectStreams(tracks)

    expect(stream.height).toBe(1440)
  })

  it('(c) excludes non-video tracks and video tracks not tagged engage-download', () => {
    const tracks = [
      mkTrack({ flavor: 'captions/source+en', isVideo: false, mimetype: 'text/vtt', tags: [] }),
      mkTrack({ flavor: 'presenter/preview', tags: ['engage-streaming'] }), // no engage-download
      mkTrack({ flavor: 'presentation/delivery', mimetype: 'video/webm' }), // not video/mp4
      mkTrack({ flavor: 'audience/other', height: 720, width: 1280 }), // the only eligible one
    ]

    const streams = selectStreams(tracks)

    expect(streams).toHaveLength(1)
    expect(streams[0].flavorType).toBe('audience')
  })

  it('(d) real Coffee Run fixture yields exactly one stream (presenter, 1920 wide)', () => {
    const [episode] = parseEpisodeResponse(episodeCoffeeRunFixture)

    const streams = selectStreams(episode.tracks)

    expect(streams).toHaveLength(1)
    expect(streams[0].flavorType).toBe('presenter')
    expect(streams[0].width).toBe(1920)
  })

  it('treats tracks without a known resolution as lowest quality: only picked when nothing in the flavor reports a resolution', () => {
    // A track with no video.resolution (so width/height are undefined) is
    // never preferred over a track whose resolution IS known - it's only
    // eligible when it's the sole option for that flavor.
    const withKnownResolution = [mkTrack({ height: 720, width: 1280 }), mkTrack({ width: undefined, height: undefined })]
    const [stream] = selectStreams(withKnownResolution)
    expect(stream.height).toBe(720)

    const onlyUnknownResolution = [mkTrack({ width: undefined, height: undefined })]
    const [fallback] = selectStreams(onlyUnknownResolution)
    expect(fallback.height).toBeUndefined()
    expect(fallback.url).toBe(onlyUnknownResolution[0].url)
  })
})

describe('findCaptionsTrack', () => {
  it('(e) finds the captions track from the captions fixture', () => {
    const [episode] = parseEpisodeResponse(captionsEpisodeFixture)

    const captionsTrack = findCaptionsTrack(episode.tracks)

    expect(captionsTrack).toBeDefined()
    expect(captionsTrack?.isCaptions).toBe(true)
    expect(captionsTrack?.flavor).toBe('captions/source+en')
  })

  it('(e) never returns a video track, and returns undefined when there are no captions tracks at all', () => {
    const videoOnly = [mkTrack({ flavor: 'presenter/preview' }), mkTrack({ flavor: 'presentation/delivery' })]

    expect(findCaptionsTrack(videoOnly)).toBeUndefined()
  })

  it('prefers the engage-download tagged captions track over one without it', () => {
    const notTagged = mkTrack({
      flavor: 'captions/source+de',
      isVideo: false,
      mimetype: 'text/vtt',
      tags: [],
      url: 'https://example.org/de.vtt',
    })
    const tagged = mkTrack({
      flavor: 'captions/source+en',
      isVideo: false,
      mimetype: 'text/vtt',
      tags: ['engage-download'],
      url: 'https://example.org/en.vtt',
    })

    const found = findCaptionsTrack([notTagged, tagged])

    expect(found?.flavor).toBe('captions/source+en')
  })

  it('prefers a vtt subtype/url over a non-vtt one when neither is tagged engage-download', () => {
    const dfxp = mkTrack({
      flavor: 'captions/source+en',
      isVideo: false,
      mimetype: 'application/ttml+xml',
      tags: [],
      url: 'https://example.org/captions.dfxp',
    })
    const vtt = mkTrack({
      flavor: 'captions/source+de',
      isVideo: false,
      mimetype: 'text/vtt',
      tags: [],
      url: 'https://example.org/captions.vtt',
    })

    const found = findCaptionsTrack([dfxp, vtt])

    expect(found?.mimetype).toBe('text/vtt')
  })
})
