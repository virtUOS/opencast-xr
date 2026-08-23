import { describe, expect, it, vi } from 'vitest'
import episodesListFixture from './__fixtures__/episodes-list.json'
import seriesListFixture from './__fixtures__/series-list.json'
import episodeCoffeeRunFixture from './__fixtures__/episode-coffee-run.json'
import captionsEpisodeFixture from './__fixtures__/captions-episode.json'
import chaosVtt from './__fixtures__/captions-was-ist-chaos.vtt?raw'
import { parseEpisodeResponse } from './parse'
import { OpencastClient, OpencastError } from './client'

/* eslint-disable @typescript-eslint/no-explicit-any */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/vtt' } })
}

// Typed the same shape as `fetch` itself, so every `vi.fn(...)` stub below
// carries the real (input, init) => Promise<Response> signature - otherwise
// TS infers a 0-arg mock from callbacks that ignore their arguments, and
// `.mock.calls[0]` becomes an empty tuple.
type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

describe('OpencastClient', () => {
  describe('listSeries', () => {
    it('requests /search/series.json and parses the response', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(seriesListFixture))
      const client = new OpencastClient({ fetchFn })

      const series = await client.listSeries()

      expect(series.length).toBeGreaterThan(0)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      const [calledUrl] = fetchFn.mock.calls[0]
      const url = new URL(String(calledUrl))
      expect(url.pathname).toBe('/search/series.json')
    })
  })

  describe('listEpisodes', () => {
    it('builds the query string from sid/q/limit/offset, asserted on parsed params not string equality', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(episodesListFixture))
      const client = new OpencastClient({ fetchFn })

      await client.listEpisodes({ sid: 'ID-blender-foundation', q: 'coffee', limit: 5, offset: 10 })

      const [calledUrl] = fetchFn.mock.calls[0]
      const url = new URL(String(calledUrl))
      expect(url.pathname).toBe('/search/episode.json')
      expect(url.searchParams.get('sid')).toBe('ID-blender-foundation')
      expect(url.searchParams.get('q')).toBe('coffee')
      expect(url.searchParams.get('limit')).toBe('5')
      expect(url.searchParams.get('offset')).toBe('10')
    })

    it('omits params that were not passed', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(episodesListFixture))
      const client = new OpencastClient({ fetchFn })

      await client.listEpisodes()

      const [calledUrl] = fetchFn.mock.calls[0]
      const url = new URL(String(calledUrl))
      expect(url.searchParams.has('sid')).toBe(false)
      expect(url.searchParams.has('q')).toBe(false)
      expect(url.searchParams.has('limit')).toBe(false)
      expect(url.searchParams.has('offset')).toBe(false)
    })

    it('returns the top-level "total" field from the recorded fixture alongside parsed episodes', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(episodesListFixture))
      const client = new OpencastClient({ fetchFn })

      const { episodes, total } = await client.listEpisodes()

      expect(episodes).toHaveLength(10)
      expect(total).toBe((episodesListFixture as { total: number }).total)
      expect(total).toBe(20)
    })

    it('tolerates the older "search-results.total" nested shape', async () => {
      const nested = { 'search-results': { result: (episodesListFixture as any).result, total: 42 } }
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(nested))
      const client = new OpencastClient({ fetchFn })

      const { total } = await client.listEpisodes()

      expect(total).toBe(42)
    })

    it("passes the RequestInit through authorize, and a header the hook sets reaches fetchFn", async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(episodesListFixture))
      const authorize = vi.fn((init: RequestInit, _url: string): RequestInit => ({
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: 'Bearer test-token' },
      }))
      const client = new OpencastClient({ fetchFn, authorize })

      await client.listEpisodes()

      expect(authorize).toHaveBeenCalledTimes(1)
      const [, calledInit] = fetchFn.mock.calls[0]
      expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' })
    })

    it('rewrites every track url, the episode previewUrl, and a constructed segment preview through resolveAssetUrl', async () => {
      // Real fixtures carry no `segments` block; augment the real captions
      // episode's mediapackage with a constructed segment, matching how
      // parse.test.ts defines the segments contract (no recorded fixture
      // exercises it).
      const rawEntry = (captionsEpisodeFixture as any).result[0]
      const augmented = {
        result: {
          ...rawEntry,
          segments: {
            segment: [
              { time: '0', duration: '5000', text: 'Intro', previews: { preview: { $: 'https://example.org/seg-0.jpg' } } },
            ],
          },
        },
        total: 1,
      }
      const [expectedRaw] = parseEpisodeResponse(augmented)
      expect(expectedRaw.tracks.length).toBeGreaterThanOrEqual(2)
      expect(expectedRaw.segments).toHaveLength(1)
      expect(expectedRaw.previewUrl).toBeDefined()

      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(augmented))
      const resolveAssetUrl = (url: string) => `https://cdn.example.test/?u=${encodeURIComponent(url)}`
      const client = new OpencastClient({ fetchFn, resolveAssetUrl })

      const { episodes } = await client.listEpisodes()
      const [episode] = episodes

      expect(episode.previewUrl).toBe(resolveAssetUrl(expectedRaw.previewUrl as string))
      expect(episode.tracks.map((t) => t.url)).toEqual(expectedRaw.tracks.map((t) => resolveAssetUrl(t.url)))
      expect(episode.segments.map((s) => s.previewUrl)).toEqual(
        expectedRaw.segments.map((s) => resolveAssetUrl(s.previewUrl as string)),
      )
    })
  })

  describe('getEpisode', () => {
    it('requests /search/episode.json?id=... and returns the parsed, rewritten episode', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse(episodeCoffeeRunFixture))
      const resolveAssetUrl = (url: string) => `${url}#resolved`
      const client = new OpencastClient({ fetchFn, resolveAssetUrl })

      const episode = await client.getEpisode('ID-coffee-run')

      expect(episode?.id).toBe('ID-coffee-run')
      expect(episode?.tracks[0].url.endsWith('#resolved')).toBe(true)
      const [calledUrl] = fetchFn.mock.calls[0]
      const url = new URL(String(calledUrl))
      expect(url.pathname).toBe('/search/episode.json')
      expect(url.searchParams.get('id')).toBe('ID-coffee-run')
    })

    it('returns undefined when the search yields no result', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse({ result: [], total: 0, offset: 0, limit: 1 }))
      const client = new OpencastClient({ fetchFn })

      const episode = await client.getEpisode('missing')

      expect(episode).toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('throws an OpencastError carrying the HTTP status when the request fails', async () => {
      const fetchFn = vi.fn<FetchStub>(async () => jsonResponse({ error: 'boom' }, 500))
      const client = new OpencastClient({ fetchFn })

      await expect(client.listSeries()).rejects.toBeInstanceOf(OpencastError)
      await expect(client.listSeries()).rejects.toMatchObject({ status: 500 })
    })
  })

  describe('loadCaptions', () => {
    it('finds the captions track, fetches its VTT through fetchFn, and returns parsed cues', async () => {
      const [episode] = parseEpisodeResponse(captionsEpisodeFixture)
      const fetchFn = vi.fn<FetchStub>(async (url) => {
        const u = String(url)
        if (u.toLowerCase().endsWith('.vtt')) return textResponse(chaosVtt)
        throw new Error(`unexpected fetch: ${u}`)
      })
      const client = new OpencastClient({ fetchFn })

      const cues = await client.loadCaptions(episode)

      expect(cues.length).toBeGreaterThan(0)
      expect(cues[0].text.length).toBeGreaterThan(0)
    })

    it('returns [] for an episode with no captions track (Coffee Run), without calling fetchFn', async () => {
      const [coffeeRun] = parseEpisodeResponse(episodeCoffeeRunFixture)
      const fetchFn = vi.fn<FetchStub>(async () => {
        throw new Error('fetchFn should not be called when there is no captions track')
      })
      const client = new OpencastClient({ fetchFn })

      const cues = await client.loadCaptions(coffeeRun)

      expect(cues).toEqual([])
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('routes the captions fetch through authorize too', async () => {
      const [episode] = parseEpisodeResponse(captionsEpisodeFixture)
      const fetchFn = vi.fn<FetchStub>(async () => textResponse(chaosVtt))
      const authorize = vi.fn((init: RequestInit, _url: string): RequestInit => ({
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: 'Bearer t' },
      }))
      const client = new OpencastClient({ fetchFn, authorize })

      await client.loadCaptions(episode)

      const [, calledInit] = fetchFn.mock.calls[0]
      expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer t' })
    })

    it('end-to-end: an Episode from getEpisode (already rewritten by resolveAssetUrl) makes loadCaptions fetch the RESOLVED captions URL', async () => {
      // This is the invariant the brief calls most defect-prone: the two
      // loadCaptions tests above build their Episode straight from
      // parseEpisodeResponse, bypassing rewriteEpisode entirely. Here the
      // Episode instead comes from the client's own public getEpisode(),
      // through a non-identity resolveAssetUrl, and that same Episode is
      // what loadCaptions consumes - proving no unresolved URL can reach
      // the captions fetch via the public API.
      const resolveAssetUrl = (url: string) => `${url}?token=x`
      const fetchFn = vi.fn<FetchStub>(async (input) => {
        const url = String(input)
        if (url.includes('/search/episode.json')) return jsonResponse(captionsEpisodeFixture)
        if (url.includes('.vtt')) return textResponse(chaosVtt)
        throw new Error(`unexpected fetch: ${url}`)
      })
      const client = new OpencastClient({ fetchFn, resolveAssetUrl })

      const episode = await client.getEpisode('ID-was-ist-chaos')
      expect(episode).toBeDefined()
      const captionsTrack = episode?.tracks.find((t) => t.isCaptions)
      expect(captionsTrack?.url.endsWith('?token=x')).toBe(true)

      const cues = await client.loadCaptions(episode as NonNullable<typeof episode>)

      expect(cues.length).toBeGreaterThan(0)
      const vttCalls = fetchFn.mock.calls.filter(([input]) => String(input).includes('.vtt'))
      expect(vttCalls).toHaveLength(1)
      const [vttUrl] = vttCalls[0]
      expect(String(vttUrl)).toBe(captionsTrack?.url)
      expect(String(vttUrl).endsWith('?token=x')).toBe(true)
    })
  })
})
