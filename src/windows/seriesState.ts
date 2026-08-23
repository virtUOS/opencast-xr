import { createStore } from 'zustand'
import type { Episode } from '../opencast/types'

/**
 * The slice of `OpencastClient` this module actually calls - a structural
 * interface, not `import type { OpencastClient }`, so tests can hand it a
 * plain stub (same reasoning as `libraryState.ts`'s `LibraryClient`).
 */
export interface SeriesClient {
  listEpisodes(p: { sid: string; limit?: number; offset?: number }): Promise<{ episodes: Episode[]; total: number }>
}

/** Series are expected to be small (per the brief) - one page almost always covers it; "Mehr laden" exists for the rest. */
const PAGE_SIZE = 12

export interface SeriesState {
  client: SeriesClient
  /** The series currently loaded (or being loaded) - null before the first `load()`. */
  sid: string | null
  episodes: Episode[]
  loading: boolean
  error: string | null
  hasMore: boolean
  offset: number
  total: number
  /**
   * Fetches page 1 for `sid`, replacing whatever was loaded before -
   * whether that was a different series, or the same one. `SeriesWindow`'s
   * effect is what decides WHEN to call this (keyed on the open episode's
   * `seriesId`); this module has no opinion on "already loaded, skip it".
   */
  load(sid: string): Promise<void>
  /** Next page for the CURRENTLY loaded series; a no-op before any `load()`, or while a fetch is already in flight. */
  loadMore(): Promise<void>
  /** Re-runs whichever fetch (initial or "more") last failed; a no-op if nothing failed. */
  retry(): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Fetch/pagination state for `SeriesWindow` (Task 14) - the sid-scoped
 * counterpart of `libraryState.ts`'s episode pagination, trimmed to what
 * one series needs: no series-vs-singles scope, no level/navigation, just
 * "the episodes of this sid, paged, with a race-token so a slow fetch for a
 * series the caller has since moved on from can't land on top of a newer
 * one's state" - the same class of bug `libraryState.test.ts`'s "code
 * review I1" tests cover there.
 */
export function createSeriesState(client: SeriesClient) {
  const store = createStore<SeriesState>()((set, get) => {
    let lastFailedAction: (() => Promise<void>) | null = null

    // Bumped by every `load()` call, including a re-load of the SAME sid
    // (still a fresh request superseding whatever fetch might already be in
    // flight for it). A fetch captures the generation when it starts and
    // checks it again when it resolves or rejects, discarding its result if
    // the generation has since moved on - see `libraryState.ts`'s
    // `episodesGeneration` for the identical reasoning. `loadMore` does NOT
    // bump it (same scope's next page), matching `loadMoreEpisodes`'s own
    // same-generation guard there.
    let generation = 0

    async function fetchPage(sid: string, offset: number, reset: boolean, gen: number): Promise<void> {
      const { episodes: page, total } = await get().client.listEpisodes({ sid, limit: PAGE_SIZE, offset })
      if (gen !== generation) return // stale - a newer load() has taken over
      const nextOffset = offset + page.length
      set((state) => ({
        episodes: reset ? page : [...state.episodes, ...page],
        offset: nextOffset,
        total,
        hasMore: nextOffset < total,
        loading: false,
        error: null,
      }))
    }

    async function run(action: () => Promise<void>, gen: number): Promise<void> {
      const attempt = () => run(action, gen)
      set({ loading: true, error: null })
      try {
        await action()
        if (gen !== generation) return
        lastFailedAction = null
      } catch (err) {
        if (gen !== generation) return
        set({ loading: false, error: errorMessage(err) })
        lastFailedAction = attempt
      }
    }

    return {
      client,
      sid: null,
      episodes: [],
      loading: false,
      error: null,
      hasMore: false,
      offset: 0,
      total: 0,

      async load(sid) {
        lastFailedAction = null
        generation += 1
        const gen = generation
        set({ sid, episodes: [], offset: 0, total: 0, hasMore: false })
        await run(() => fetchPage(sid, 0, true, gen), gen)
      },

      async loadMore() {
        const { sid, loading, offset } = get()
        if (sid === null || loading) return
        await run(() => fetchPage(sid, offset, false, generation), generation)
      },

      async retry() {
        if (lastFailedAction) await lastFailedAction()
      },
    }
  })

  return store
}

export type SeriesStateApi = ReturnType<typeof createSeriesState>
