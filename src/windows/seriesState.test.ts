import { describe, expect, it, vi } from 'vitest'
import type { Episode } from '../opencast/types'
import { createSeriesState, type SeriesClient } from './seriesState'

function makeEpisode(id: string): Episode {
  return {
    id,
    title: `Title ${id}`,
    durationMs: 60_000,
    creators: [],
    tracks: [],
    segments: [],
  }
}

function makeClient(): SeriesClient & { listEpisodes: ReturnType<typeof vi.fn> } {
  return { listEpisodes: vi.fn(async () => ({ episodes: [] as Episode[], total: 0 })) }
}

/** A promise plus externally-callable resolve/reject, for interleaving two in-flight fetches by hand - same helper as libraryState.test.ts. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSeriesState', () => {
  it('load fetches page 1 for the given sid and sets hasMore from the total', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('e1'), makeEpisode('e2')], total: 5 })
    const store = createSeriesState(client)

    await store.getState().load('s1')

    expect(client.listEpisodes).toHaveBeenCalledWith({ sid: 's1', limit: 12, offset: 0 })
    expect(store.getState().sid).toBe('s1')
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(store.getState().hasMore).toBe(true) // 2 < 5
    expect(store.getState().offset).toBe(2)
    expect(store.getState().loading).toBe(false)
    expect(store.getState().error).toBeNull()
  })

  it('load replaces a previously loaded series entirely, including a re-load of the SAME sid', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('a1')], total: 1 })
    const store = createSeriesState(client)
    await store.getState().load('a')

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('b1'), makeEpisode('b2')], total: 2 })
    await store.getState().load('b')
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1', 'b2'])

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('b1')], total: 1 })
    await store.getState().load('b') // re-load of the same sid - still a fresh reset, not an append
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1'])
  })

  it('loadMore appends the next page at the right offset', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('e1')], total: 3 })
    const store = createSeriesState(client)
    await store.getState().load('s1')

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('e2'), makeEpisode('e3')], total: 3 })
    await store.getState().loadMore()

    expect(client.listEpisodes).toHaveBeenLastCalledWith({ sid: 's1', limit: 12, offset: 1 })
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(store.getState().hasMore).toBe(false)
  })

  it('loadMore before any load() is a no-op', async () => {
    const client = makeClient()
    const store = createSeriesState(client)
    await store.getState().loadMore()
    expect(client.listEpisodes).not.toHaveBeenCalled()
  })

  it('a fetch failure sets error, and retry() re-requests the same page', async () => {
    const client = makeClient()
    client.listEpisodes.mockRejectedValueOnce(new Error('network down'))
    const store = createSeriesState(client)

    await store.getState().load('s1')
    expect(store.getState().error).toBe('network down')
    expect(store.getState().episodes).toEqual([])

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('e1')], total: 1 })
    await store.getState().retry()

    expect(store.getState().error).toBeNull()
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1'])
  })

  it('loadMore ignores a second call while the first page is still in flight (no duplicate tiles)', async () => {
    const client = makeClient()
    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('e1')], total: 5 })
    const store = createSeriesState(client)
    await store.getState().load('s1')

    const page2 = deferred<{ episodes: Episode[]; total: number }>()
    client.listEpisodes.mockReturnValueOnce(page2.promise)

    const call1 = store.getState().loadMore()
    const call2 = store.getState().loadMore()

    expect(client.listEpisodes).toHaveBeenCalledTimes(2) // load's own call + ONE loadMore

    page2.resolve({ episodes: [makeEpisode('e2')], total: 5 })
    await call1
    await call2

    expect(client.listEpisodes).toHaveBeenCalledTimes(2)
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('a slow load(A) resolving after switching to load(B) does not overwrite B\'s state', async () => {
    const client = makeClient()
    const store = createSeriesState(client)

    const seriesA = deferred<{ episodes: Episode[]; total: number }>()
    client.listEpisodes.mockReturnValueOnce(seriesA.promise)
    const loadA = store.getState().load('a')

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('b1')], total: 1 })
    await store.getState().load('b')

    seriesA.resolve({ episodes: [makeEpisode('a1')], total: 1 })
    await loadA

    expect(store.getState().sid).toBe('b')
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1'])
    expect(store.getState().error).toBeNull()
    expect(store.getState().loading).toBe(false)
  })

  it('a slow load(A) REJECTING after switching to load(B) does not paint an error over B', async () => {
    const client = makeClient()
    const store = createSeriesState(client)

    const seriesA = deferred<{ episodes: Episode[]; total: number }>()
    client.listEpisodes.mockReturnValueOnce(seriesA.promise)
    const loadA = store.getState().load('a')

    client.listEpisodes.mockResolvedValueOnce({ episodes: [makeEpisode('b1')], total: 1 })
    await store.getState().load('b')

    seriesA.reject(new Error('A blew up'))
    await loadA // rejection is caught inside run() - loadA itself must not throw

    expect(store.getState().error).toBeNull()
    expect(store.getState().episodes.map((e) => e.id)).toEqual(['b1'])
  })
})
