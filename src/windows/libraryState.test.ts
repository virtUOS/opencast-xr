import { describe, expect, it, vi } from 'vitest'
import type { Episode, OcTrack, Series } from '../opencast/types'
import {
  SCOPE_HEADER_MAX_CHARS,
  SINGLES_TILE_ID,
  createLibraryState,
  formatDuration,
  scopeHeaderLabel,
  seriesTiles,
  toEpisodeTile,
  type EpisodeScope,
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

// Re-review finding: the level-2 header was the one string in this app going
// into a <Text> untruncated, which is exactly the precondition for uikit
// 1.0.74's many-wrapped-lines defect that MediaList's own `truncate` documents.
describe('scopeHeaderLabel', () => {
  const series = (title: string): EpisodeScope => ({ type: 'series', sid: 's1', title })

  it('is the series title for a series scope', () => {
    expect(scopeHeaderLabel(series('AV-Portal Content'))).toBe('AV-Portal Content')
  })

  it('is the singles label for the singles scope, not a second copy of the string', () => {
    // Same literal seriesTiles uses for the level-1 tile - one owner, so the
    // header and the tile cannot drift apart.
    expect(scopeHeaderLabel({ type: 'singles' })).toBe('Einzelaufzeichnungen')
    expect(scopeHeaderLabel({ type: 'singles' })).toBe(seriesTiles([])[0].title)
  })

  it('TRUNCATES a long series title to one line, with plain ASCII dots', () => {
    const long =
      'Einfuehrung in die Theoretische Informatik, Fachbereich Mathematik/Informatik, Wintersemester 2026/27'
    const label = scopeHeaderLabel(series(long))
    expect(label).toHaveLength(SCOPE_HEADER_MAX_CHARS)
    expect(label.endsWith('...')).toBe(true)
    expect(label.startsWith('Einfuehrung in die Theoretische Informatik')).toBe(true)
  })

  it('leaves a title exactly at the limit alone, and cuts one past it', () => {
    const exact = 'x'.repeat(SCOPE_HEADER_MAX_CHARS)
    expect(scopeHeaderLabel(series(exact))).toBe(exact)
    expect(scopeHeaderLabel(series('x'.repeat(SCOPE_HEADER_MAX_CHARS + 1)))).toHaveLength(
      SCOPE_HEADER_MAX_CHARS,
    )
  })

  it('never returns more than the limit, whatever it is handed', () => {
    for (const title of ['', 'a', 'y'.repeat(5000)]) {
      expect(scopeHeaderLabel(series(title)).length).toBeLessThanOrEqual(SCOPE_HEADER_MAX_CHARS)
    }
  })

  it('stays inside the glyphs uikit 1.0.74 default font can draw', () => {
    // Same constraint as BACK_LABEL and the escape hint: diacritics render,
    // typographic punctuation comes out as tofu boxes.
    expect(scopeHeaderLabel(series('z'.repeat(200)))).not.toMatch(/[‹›„“”…·—]/)
  })

  it('is more generous than a MediaList tile title, since it owns a whole row', () => {
    // Guards the intent, not the number: a future edit that "tidies" this down
    // to a tile-sized cut would silently shorten real series names for no
    // reason - the header shares its row only with „< Zurück".
    expect(SCOPE_HEADER_MAX_CHARS).toBeGreaterThan(42)
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

  it('loadSeries surfaces a rejection as seriesError, and retrySeries() re-runs it', async () => {
    const client = makeClient()
    client.listSeries.mockRejectedValueOnce(new Error('network down'))
    const store = createLibraryState(client)

    await store.getState().loadSeries()
    expect(store.getState().seriesError).toBe('network down')
    expect(store.getState().series).toEqual([])

    client.listSeries.mockResolvedValueOnce([{ id: 's1', title: 'Series One' }])
    await store.getState().retrySeries()

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

  it('an episodes fetch failure sets episodesError without touching the already-loaded list, and retryEpisodes() re-requests the SAME page', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e1' })], total: 3 })
    const store = createLibraryState(client)
    await store.getState().enterSeries('s1', 'Series One')

    client.listEpisodes.mockRejectedValueOnce(new Error('timeout'))
    await store.getState().loadMoreEpisodes()

    expect(store.getState().episodesError).toBe('timeout')
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1']) // unchanged, not reset

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e2' })], total: 3 })
    await store.getState().retryEpisodes()

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

    // retryEpisodes() after back() is a no-op (the stale action was dropped),
    // not a resurrection of the episodes-level error.
    await store.getState().retryEpisodes()
    expect(store.getState().level).toEqual({ kind: 'series' })
  })

  // Review round, I1: LibraryWindow starts loadSeries() AND enterSeries() in
  // the SAME commit now that the dock breadcrumb's „Reihe" crumb can open
  // browse mode straight at level 2 (level 1 still has to load, because
  // „< Zurück" goes there). That put the two kinds of fetch in flight
  // together for the first time - which one shared retry slot could not
  // survive.
  describe('concurrent series + episodes fetches (review round I1)', () => {
    it('a RESOLVING series load does not disarm the failed episodes retry', async () => {
      const client = makeClient()
      const series = deferred<Series[]>()
      const episodes = deferred<{ episodes: Episode[]; total: number }>()
      client.listSeries.mockReturnValueOnce(series.promise)
      client.listEpisodes.mockReturnValueOnce(episodes.promise)
      const store = createLibraryState(client)

      // Exactly what the window does on the first frame of a scoped browse.
      const seriesRun = store.getState().loadSeries()
      const episodesRun = store.getState().enterSeries('s1', 'Series One')

      // The interleave that used to lose the retry: episodes reject FIRST
      // (arming the slot), then the series load resolves (which, with one
      // shared slot, cleared it as "nothing is failing any more").
      episodes.reject(new Error('episodes timeout'))
      await episodesRun
      series.resolve([{ id: 's1', title: 'Series One' }])
      await seriesRun

      expect(store.getState().episodesError).toBe('episodes timeout')
      expect(store.getState().seriesError).toBeNull()

      // ...and the banner's button must actually refetch the failed page.
      client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode({ id: 'e1' })], total: 1 })
      await store.getState().retryEpisodes()

      expect(client.listEpisodes).toHaveBeenLastCalledWith({ sid: 's1', limit: 12, offset: 0 })
      expect(store.getState().episodesError).toBeNull()
      expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1'])
    })

    it('a RESOLVING episodes fetch does not disarm the failed series retry', async () => {
      // The mirror image, so neither slot can be "fixed" by clearing the other.
      const client = makeClient()
      const series = deferred<Series[]>()
      const episodes = deferred<{ episodes: Episode[]; total: number }>()
      client.listSeries.mockReturnValueOnce(series.promise)
      client.listEpisodes.mockReturnValueOnce(episodes.promise)
      const store = createLibraryState(client)

      const seriesRun = store.getState().loadSeries()
      const episodesRun = store.getState().enterSeries('s1', 'Series One')

      series.reject(new Error('series down'))
      await seriesRun
      episodes.resolve({ episodes: [makeEpisode({ id: 'e1' })], total: 1 })
      await episodesRun

      expect(store.getState().seriesError).toBe('series down')
      expect(store.getState().episodesError).toBeNull()

      client.listSeries.mockResolvedValueOnce([{ id: 's1', title: 'Series One' }])
      await store.getState().retrySeries()

      expect(store.getState().seriesError).toBeNull()
      expect(store.getState().series).toEqual([{ id: 's1', title: 'Series One' }])
    })

    it('each retry drives only its own fetch - they are not one button in disguise', async () => {
      const client = makeClient()
      client.listSeries.mockRejectedValueOnce(new Error('series down'))
      client.listEpisodes.mockRejectedValueOnce(new Error('episodes down'))
      const store = createLibraryState(client)
      await store.getState().loadSeries()
      await store.getState().enterSeries('s1', 'Series One')
      const seriesCalls = client.listSeries.mock.calls.length
      const episodeCalls = client.listEpisodes.mock.calls.length

      client.listSeries.mockResolvedValueOnce([])
      await store.getState().retrySeries()

      expect(client.listSeries.mock.calls.length).toBe(seriesCalls + 1)
      expect(client.listEpisodes.mock.calls.length).toBe(episodeCalls) // untouched
      expect(store.getState().episodesError).toBe('episodes down') // still failed, still retryable
    })

    it('back() keeps a failed SERIES retry alive - level 1 is where it is going', async () => {
      const client = makeClient()
      client.listSeries.mockRejectedValueOnce(new Error('series down'))
      client.listEpisodes.mockResolvedValueOnce({ episodes: [], total: 0 })
      const store = createLibraryState(client)
      await store.getState().loadSeries()
      await store.getState().enterSeries('s1', 'Series One')

      store.getState().back()
      expect(store.getState().seriesError).toBe('series down')

      client.listSeries.mockResolvedValueOnce([{ id: 's1', title: 'Series One' }])
      await store.getState().retrySeries()

      expect(store.getState().seriesError).toBeNull()
      expect(store.getState().series).toEqual([{ id: 's1', title: 'Series One' }])
    })
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
