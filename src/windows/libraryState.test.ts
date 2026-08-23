import { describe, expect, it, vi } from 'vitest'
import type { Episode, OcTrack, Series } from '../opencast/types'
import {
  SINGLES_TILE_ID,
  createLibraryState,
  formatDuration,
  seriesTiles,
  toEpisodeTile,
  type LibraryClient,
} from './libraryState'

function playableTrack(): OcTrack[] {
  return [
    {
      id: 't1',
      flavor: 'presenter/preview',
      flavorType: 'presenter',
      mimetype: 'video/mp4',
      url: 'https://example.org/v.mp4',
      tags: ['engage-download'],
      isVideo: true,
      isCaptions: false,
    },
  ]
}

function nonPlayableTrack(): OcTrack[] {
  // A track that exists but isn't an eligible engage-download mp4 - e.g. a
  // streaming-only rendition, or a captions track with no video at all.
  return [
    {
      id: 't1',
      flavor: 'presenter/preview',
      flavorType: 'presenter',
      mimetype: 'video/mp4',
      url: 'https://example.org/v.mp4',
      tags: ['engage-streaming'],
      isVideo: true,
      isCaptions: false,
    },
  ]
}

function makeEpisode(overrides: Partial<Episode> & { id: string }): Episode {
  return {
    id: overrides.id,
    title: overrides.title ?? `Title ${overrides.id}`,
    seriesId: overrides.seriesId,
    seriesTitle: overrides.seriesTitle,
    created: overrides.created,
    durationMs: overrides.durationMs ?? 60000,
    creators: overrides.creators ?? [],
    previewUrl: overrides.previewUrl,
    tracks: overrides.tracks ?? playableTrack(),
    segments: overrides.segments ?? [],
  }
}

function makeClient(): LibraryClient & {
  listSeries: ReturnType<typeof vi.fn>
  listEpisodes: ReturnType<typeof vi.fn>
} {
  return {
    listSeries: vi.fn(async () => [] as Series[]),
    listEpisodes: vi.fn(async () => ({ episodes: [] as Episode[], total: 0 })),
  }
}

/** A promise plus externally-callable resolve/reject, for interleaving two in-flight fetches by hand in a test. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('formatDuration', () => {
  it('formats sub-minute durations as 0:MM:SS', () => {
    expect(formatDuration(5_000)).toBe('0:00:05')
  })

  it('formats an hour-plus duration with an unpadded hour', () => {
    expect(formatDuration(3_725_000)).toBe('1:02:05') // 1h 2m 5s
  })

  it('rounds to the nearest second', () => {
    expect(formatDuration(184_629)).toBe('0:03:05') // Coffee Run's real duration (184629 ms)
  })
})

describe('toEpisodeTile', () => {
  it('marks an episode with an engage-download video track as playable, no suffix', () => {
    const ep = makeEpisode({ id: 'e1', durationMs: 65_000, created: '2020-05-29T00:00:00.000Z', tracks: playableTrack() })
    const tile = toEpisodeTile(ep)
    expect(tile.playable).toBe(true)
    expect(tile.subtitle).toBe('0:01:05 - 2020-05-29')
  })

  it('marks an episode with no eligible stream as not playable, with the German suffix', () => {
    const ep = makeEpisode({ id: 'e2', durationMs: 65_000, created: '2020-05-29T00:00:00.000Z', tracks: nonPlayableTrack() })
    const tile = toEpisodeTile(ep)
    expect(tile.playable).toBe(false)
    expect(tile.subtitle).toBe('0:01:05 - 2020-05-29 - nicht abspielbar')
  })

  it('omits the date segment when the episode has no created date', () => {
    const ep = makeEpisode({ id: 'e3', durationMs: 5_000, created: undefined })
    expect(toEpisodeTile(ep).subtitle).toBe('0:00:05')
  })
})

describe('seriesTiles', () => {
  it('appends the synthetic Einzelaufzeichnungen tile after every real series', () => {
    const tiles = seriesTiles([{ id: 's1', title: 'Series One' }])
    expect(tiles).toEqual([
      { id: 's1', title: 'Series One' },
      { id: SINGLES_TILE_ID, title: 'Einzelaufzeichnungen' },
    ])
  })

  it('still includes the singles tile when there are no real series', () => {
    expect(seriesTiles([])).toEqual([{ id: SINGLES_TILE_ID, title: 'Einzelaufzeichnungen' }])
  })
})

describe('createLibraryState', () => {
  it('loadSeries populates series on success', async () => {
    const client = makeClient()
    client.listSeries.mockResolvedValueOnce([{ id: 's1', title: 'Series One' }])
    const store = createLibraryState(client)

    await store.getState().loadSeries()

    expect(store.getState().series).toEqual([{ id: 's1', title: 'Series One' }])
    expect(store.getState().seriesLoading).toBe(false)
    expect(store.getState().seriesError).toBeNull()
  })

  it('loadSeries surfaces a rejection as seriesError, and retry() re-runs it', async () => {
    const client = makeClient()
    client.listSeries.mockRejectedValueOnce(new Error('network down'))
    const store = createLibraryState(client)

    await store.getState().loadSeries()
    expect(store.getState().seriesError).toBe('network down')
    expect(store.getState().series).toEqual([])

    client.listSeries.mockResolvedValueOnce([{ id: 's1', title: 'Series One' }])
    await store.getState().retry()

    expect(store.getState().seriesError).toBeNull()
    expect(store.getState().series).toEqual([{ id: 's1', title: 'Series One' }])
  })

  it('enterSeries fetches sid-scoped episodes and sets episodesHasMore from the total', async () => {
    const client = makeClient()
    const eps = [makeEpisode({ id: 'e1' }), makeEpisode({ id: 'e2' })]
    client.listEpisodes.mockResolvedValueOnce({ episodes: eps, total: 5 })
    const store = createLibraryState(client)

    await store.getState().enterSeries('s1', 'Series One')

    expect(client.listEpisodes).toHaveBeenCalledWith({ sid: 's1', limit: 12, offset: 0 })
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(store.getState().episodesHasMore).toBe(true) // 2 < 5
    expect(store.getState().episodesOffset).toBe(2)
    expect(store.getState().level).toEqual({ kind: 'episodes', scope: { type: 'series', sid: 's1', title: 'Series One' } })
  })

  it('loadMoreEpisodes appends the next sid-scoped page at the right offset', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e1' })], total: 3 })
    const store = createLibraryState(client)
    await store.getState().enterSeries('s1', 'Series One')

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e2' }), makeEpisode({ id: 'e3' })], total: 3 })
    await store.getState().loadMoreEpisodes()

    expect(client.listEpisodes).toHaveBeenLastCalledWith({ sid: 's1', limit: 12, offset: 1 })
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(store.getState().episodesHasMore).toBe(false) // 3 < 3 is false
  })

  it('enterSingles filters out episodes that belong to a series, keyed off the raw (unfiltered) scan', async () => {
    const client = makeClient()
    const eps = [
      makeEpisode({ id: 'e1', seriesId: 's1' }),
      makeEpisode({ id: 'e2' }), // no seriesId -> a single
      makeEpisode({ id: 'e3', seriesId: 's2' }),
    ]
    client.listEpisodes.mockResolvedValueOnce({ episodes: eps, total: 10 })
    const store = createLibraryState(client)

    await store.getState().enterSingles()

    expect(client.listEpisodes).toHaveBeenCalledWith({ limit: 12, offset: 0 })
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e2'])
    // Raw scan progress (3 of 10 fetched), not "1 single found of 10" - see episodesHasMore's doc.
    expect(store.getState().episodesHasMore).toBe(true)
    expect(store.getState().episodesOffset).toBe(3)
  })

  it('loadMoreEpisodes on a singles scope keeps scanning even when a page matches nothing', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({
      episodes: [makeEpisode({ id: 'e1', seriesId: 's1' })],
      total: 4,
    })
    const store = createLibraryState(client)
    await store.getState().enterSingles()
    expect(store.getState().episodes).toEqual([])
    expect(store.getState().episodesHasMore).toBe(true) // offset 1 < total 4

    client.listEpisodes.mockResolvedValueOnce({
      episodes: [makeEpisode({ id: 'e2', seriesId: 's2' }), makeEpisode({ id: 'e3' })],
      total: 4,
    })
    await store.getState().loadMoreEpisodes()

    expect(client.listEpisodes).toHaveBeenLastCalledWith({ limit: 12, offset: 1 })
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e3'])
    expect(store.getState().episodesHasMore).toBe(true) // raw offset 3 < raw total 4 - one more page to scan
  })

  it('an episodes fetch failure sets episodesError without touching the already-loaded list, and retry() re-requests the SAME page', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e1' })], total: 3 })
    const store = createLibraryState(client)
    await store.getState().enterSeries('s1', 'Series One')

    client.listEpisodes.mockRejectedValueOnce(new Error('timeout'))
    await store.getState().loadMoreEpisodes()

    expect(store.getState().episodesError).toBe('timeout')
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1']) // unchanged, not reset

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e2' })], total: 3 })
    await store.getState().retry()

    // Retry re-requested offset 1 (the page that failed), not offset 0.
    expect(client.listEpisodes).toHaveBeenLastCalledWith({ sid: 's1', limit: 12, offset: 1 })
    expect(store.getState().episodesError).toBeNull()
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('back() returns to level "series" without refetching series, and drops the episodes error/list', async () => {
    const client = makeClient()
    client.listSeries.mockResolvedValueOnce([{ id: 's1', title: 'Series One' }])
    client.listEpisodes.mockRejectedValueOnce(new Error('boom'))
    const store = createLibraryState(client)

    await store.getState().loadSeries()
    await store.getState().enterSeries('s1', 'Series One')
    expect(store.getState().episodesError).toBe('boom')

    store.getState().back()

    expect(store.getState().level).toEqual({ kind: 'series' })
    expect(store.getState().episodes).toEqual([])
    expect(store.getState().episodesError).toBeNull()
    expect(store.getState().series).toEqual([{ id: 's1', title: 'Series One' }]) // still cached
    expect(client.listSeries).toHaveBeenCalledTimes(1) // not refetched

    // retry() after back() is a no-op (the stale action was dropped), not a
    // resurrection of the episodes-level error.
    await store.getState().retry()
    expect(store.getState().level).toEqual({ kind: 'series' })
  })

  // Code review findings I1(A)/(B): two concurrency bugs in the pagination/
  // fetch path, neither exercised by the sequential tests above.
  describe('concurrency (code review I1)', () => {
    it('scenario A: a second "Mehr laden" click while the first page is still in flight is ignored - no duplicate tiles, no corrupted offset/total', async () => {
      const client = makeClient()
      client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e1' })], total: 5 })
      const store = createLibraryState(client)
      await store.getState().enterSeries('s1', 'Series One')

      const page2 = deferred<{ episodes: Episode[]; total: number }>()
      client.listEpisodes.mockReturnValueOnce(page2.promise)

      // Two rapid clicks, both fired before the first page's fetch resolves.
      const call1 = store.getState().loadMoreEpisodes()
      const call2 = store.getState().loadMoreEpisodes()

      // The guard is synchronous (checks episodesLoading before ever calling
      // the client), so the second click must never reach listEpisodes at
      // all - only 2 calls total exist: enterSeries's own, plus ONE loadMore.
      expect(client.listEpisodes).toHaveBeenCalledTimes(2)
      expect(store.getState().episodesLoading).toBe(true)

      page2.resolve({ episodes: [makeEpisode({ id: 'e2' })], total: 5 })
      await call1
      await call2

      expect(client.listEpisodes).toHaveBeenCalledTimes(2) // still just 2 - call2 never issued a request
      expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2']) // appended exactly once, no duplicate
      expect(store.getState().episodesOffset).toBe(2)
      expect(store.getState().episodesTotal).toBe(5)
      expect(store.getState().episodesHasMore).toBe(true) // 2 < 5
      expect(store.getState().episodesLoading).toBe(false)
    })

    it('scenario B: a slow series-A fetch resolving AFTER switching to series B does not overwrite B\'s state', async () => {
      const client = makeClient()
      const store = createLibraryState(client)

      const seriesA = deferred<{ episodes: Episode[]; total: number }>()
      client.listEpisodes.mockReturnValueOnce(seriesA.promise)
      const enterA = store.getState().enterSeries('a', 'Series A') // starts, awaiting seriesA.promise

      // Switch to series B before A's fetch resolves.
      client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'b1' })], total: 1 })
      await store.getState().enterSeries('b', 'Series B')

      expect(store.getState().level).toEqual({
        kind: 'episodes',
        scope: { type: 'series', sid: 'b', title: 'Series B' },
      })
      expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1'])

      // NOW A's stale fetch resolves - it must be discarded, not applied on
      // top of B's already-loaded state.
      seriesA.resolve({ episodes: [makeEpisode({ id: 'a1' })], total: 1 })
      await enterA

      expect(store.getState().level).toEqual({
        kind: 'episodes',
        scope: { type: 'series', sid: 'b', title: 'Series B' },
      })
      expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1']) // NOT ['a1'] or ['b1','a1']
      expect(store.getState().episodesError).toBeNull()
      expect(store.getState().episodesLoading).toBe(false)
    })

    it('scenario B, failure path: a slow series-A fetch REJECTING after switching to series B does not paint an error over B', async () => {
      const client = makeClient()
      const store = createLibraryState(client)

      const seriesA = deferred<{ episodes: Episode[]; total: number }>()
      client.listEpisodes.mockReturnValueOnce(seriesA.promise)
      const enterA = store.getState().enterSeries('a', 'Series A')

      client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'b1' })], total: 1 })
      await store.getState().enterSeries('b', 'Series B')

      seriesA.reject(new Error('A blew up'))
      await enterA // the rejection is caught inside runEpisodesFetch - enterA itself must not throw

      expect(store.getState().episodesError).toBeNull()
      expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1'])
      expect(store.getState().episodesLoading).toBe(false)
    })
  })
})
