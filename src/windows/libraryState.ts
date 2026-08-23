import { createStore } from 'zustand'
import type { Episode, Series } from '../opencast/types'
import { selectStreams } from '../opencast/selectTracks'
import { formatDuration } from '../time'

/**
 * The slice of OpencastClient this module actually calls. Kept as a
 * structural interface (not `import type { OpencastClient }`) so tests can
 * hand it a plain stub object instead of constructing a real client - see
 * libraryState.test.ts.
 */
export interface LibraryClient {
  listSeries(): Promise<Series[]>
  listEpisodes(p?: {
    sid?: string
    q?: string
    limit?: number
    offset?: number
  }): Promise<{ episodes: Episode[]; total: number }>
}

/** Synthetic id for the "Einzelaufzeichnungen" group tile at level 1 - never a real server-issued series id. */
export const SINGLES_TILE_ID = '__singles__'

const SINGLES_TITLE = 'Einzelaufzeichnungen'

/** Page size for both the sid-scoped pagination and the singles client-side scan. */
const PAGE_SIZE = 12

/**
 * What level-2 (the episode list) is currently showing. `series` is a real
 * server-side filter (`listEpisodes({ sid })`); `singles` has no server-side
 * equivalent - it is a client-side filter over the WHOLE catalogue
 * (`listEpisodes({})`, keeping episodes whose `seriesId` is undefined).
 */
export type EpisodeScope = { type: 'series'; sid: string; title: string } | { type: 'singles' }

export type LibraryLevel = { kind: 'series' } | { kind: 'episodes'; scope: EpisodeScope }

export interface LibraryTile {
  id: string
  title: string
}

export interface EpisodeTile {
  id: string
  title: string
  subtitle: string
  imageUrl?: string
  /**
   * False iff `selectStreams(ep.tracks)` found no eligible engage-download
   * video track. A tile with `playable: false` must still be shown (so the
   * user can see the recording exists) but selecting it must never call
   * `openEpisode` - there is nothing for the player to play.
   */
  playable: boolean
}

export interface LibraryState {
  client: LibraryClient
  level: LibraryLevel

  series: Series[]
  seriesLoading: boolean
  seriesError: string | null

  /** Episodes accumulated so far for the CURRENT level-2 scope; reset on enterSeries/enterSingles/back. */
  episodes: Episode[]
  episodesLoading: boolean
  episodesError: string | null
  /**
   * Whether "Mehr laden" is worth showing. For a `series` scope this is the
   * ordinary `episodes.length < total` (the server already filtered by sid).
   * For `singles` the filtering happens CLIENT-SIDE over an unfiltered
   * `listEpisodes({})` scan, so it instead means "the scan has not reached
   * the end of the whole catalogue yet" - see episodesOffset/episodesTotal.
   */
  episodesHasMore: boolean
  /** Next raw offset to request. "Raw" = into the unfiltered scan for `singles`, into the sid-filtered list for `series`. */
  episodesOffset: number
  /** Raw total backing episodesOffset/episodesHasMore - see episodesHasMore's doc for why "raw". */
  episodesTotal: number

  loadSeries(): Promise<void>
  enterSeries(sid: string, title: string): Promise<void>
  enterSingles(): Promise<void>
  loadMoreEpisodes(): Promise<void>
  /** Re-runs whichever async action last failed (a series load, an initial episodes fetch, or a loadMore) - a no-op if nothing failed. */
  retry(): Promise<void>
  /** Level 2 -> level 1. Series stay cached (no refetch); the episode list and any episodes error are dropped. */
  back(): void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Level-1 tiles: every real series, plus the synthetic "Einzelaufzeichnungen" group tile last. */
export function seriesTiles(series: Series[]): LibraryTile[] {
  return [...series.map((s) => ({ id: s.id, title: s.title })), { id: SINGLES_TILE_ID, title: SINGLES_TITLE }]
}

// Re-exported (not just imported for local use) because this module's own
// tests import `formatDuration` from here - it originated in this file
// (Task 11) before Task 13's dock timeline needed the same h/m/s split logic
// in a different shape ("M:SS" under an hour). Rather than duplicate the
// div/mod arithmetic, both now go through `../time`, which is what actually
// owns it; this file keeps re-exporting the name so nothing else has to change.
export { formatDuration } from '../time'

/** ISO date substring (YYYY-MM-DD) - deterministic across locales/timezones (and tests), unlike toLocaleDateString. */
function formatDate(created: string | undefined): string | undefined {
  return created ? created.slice(0, 10) : undefined
}

/**
 * Level-2 tile for one episode: duration + date subtitle, "nicht abspielbar"
 * suffix when it has no playable stream.
 *
 * Separator is a plain ASCII " - ", not a typographic middle dot ("·") - live
 * verification on develop.opencast.org showed uikit's default font (this
 * project's installed @react-three/uikit 1.0.74) rendering "·" as a tofu
 * box, the same class of missing-glyph defect WindowFrame.tsx's doc comment
 * already documents for "–" and "✕". ASCII is the safe subset.
 */
export function toEpisodeTile(ep: Episode): EpisodeTile {
  const playable = selectStreams(ep.tracks).length > 0
  const date = formatDate(ep.created)
  const parts = [formatDuration(ep.durationMs)]
  if (date) parts.push(date)
  let subtitle = parts.join(' - ')
  if (!playable) subtitle += ' - nicht abspielbar'
  return { id: ep.id, title: ep.title, subtitle, imageUrl: ep.previewUrl, playable }
}

export function createLibraryState(client: LibraryClient) {
  const store = createStore<LibraryState>()((set, get) => {
    // Set once an attempt fails, cleared once one succeeds. Re-invoking it IS
    // retry(): it re-enters the same guarded path (runEpisodesFetch /
    // loadSeries' own attempt), so a retry that fails again correctly
    // re-arms itself instead of throwing unhandled - and a loadMore retry
    // re-requests the SAME page rather than resetting the list, because the
    // `reset` flag was captured in the closure when the action was first
    // built, not re-derived from state.
    let lastFailedAction: (() => Promise<void>) | null = null

    // Bumped by enterSeries/enterSingles/back - i.e. every genuine scope
    // change. NOT bumped by loadMoreEpisodes (continues the SAME scope's
    // next page - see its own dedicated guard below) or by retry() (which
    // continues whatever scope its stored action closure already belongs
    // to). A fetch captures the generation in force when it STARTS and
    // checks it again when it resolves (or rejects), discarding its result
    // entirely if the generation has since moved on. This is what stops a
    // slow series-A fetch from landing on top of series-B's state after the
    // user has already switched (code review finding I1, scenario B).
    //
    // Deliberately NOT used to BLOCK a switch while a previous fetch is
    // still in flight: a user can always abandon a slow request and
    // navigate elsewhere rather than being stuck waiting for it - the
    // generation check is what makes that safe, not a guard that would
    // prevent it.
    let episodesGeneration = 0

    async function fetchEpisodesPage(scope: EpisodeScope, reset: boolean, gen: number): Promise<void> {
      const offset = reset ? 0 : get().episodesOffset
      const params =
        scope.type === 'series'
          ? { sid: scope.sid, limit: PAGE_SIZE, offset }
          : { limit: PAGE_SIZE, offset }
      const { episodes: page, total } = await get().client.listEpisodes(params)
      // Stale: a newer scope has taken over since this fetch started - see
      // episodesGeneration's doc. Applying this result now would silently
      // overwrite whatever the current generation's own fetch has already
      // written, or is still in the middle of writing.
      if (gen !== episodesGeneration) return
      const matched = scope.type === 'series' ? page : page.filter((e) => e.seriesId === undefined)
      const nextOffset = offset + page.length
      set((state) => ({
        episodes: reset ? matched : [...state.episodes, ...matched],
        episodesOffset: nextOffset,
        episodesTotal: total,
        episodesHasMore: nextOffset < total,
        episodesLoading: false,
        episodesError: null,
      }))
    }

    async function runEpisodesFetch(action: () => Promise<void>, gen: number): Promise<void> {
      const attempt = () => runEpisodesFetch(action, gen)
      set({ episodesLoading: true, episodesError: null })
      try {
        await action()
        if (gen !== episodesGeneration) return // stale - see fetchEpisodesPage's doc
        lastFailedAction = null
      } catch (err) {
        // Stale rejection: don't paint an error banner over a scope the
        // user has since navigated away from.
        if (gen !== episodesGeneration) return
        set({ episodesLoading: false, episodesError: errorMessage(err) })
        lastFailedAction = attempt
      }
    }

    return {
      client,
      level: { kind: 'series' },

      series: [],
      seriesLoading: false,
      seriesError: null,

      episodes: [],
      episodesLoading: false,
      episodesError: null,
      episodesHasMore: false,
      episodesOffset: 0,
      episodesTotal: 0,

      async loadSeries() {
        const attempt = async () => {
          set({ seriesLoading: true, seriesError: null })
          try {
            const series = await get().client.listSeries()
            set({ series, seriesLoading: false, seriesError: null })
            lastFailedAction = null
          } catch (err) {
            set({ seriesLoading: false, seriesError: errorMessage(err) })
            lastFailedAction = attempt
          }
        }
        await attempt()
      },

      async enterSeries(sid, title) {
        const scope: EpisodeScope = { type: 'series', sid, title }
        // Drop a stale episodes-retry action too: it belongs to the scope
        // being left, and re-running it after switching would silently
        // refill state for a scope the user is no longer looking at.
        lastFailedAction = null
        episodesGeneration += 1
        const gen = episodesGeneration
        set({
          level: { kind: 'episodes', scope },
          episodes: [],
          episodesOffset: 0,
          episodesTotal: 0,
          episodesHasMore: false,
        })
        await runEpisodesFetch(() => fetchEpisodesPage(scope, true, gen), gen)
      },

      async enterSingles() {
        const scope: EpisodeScope = { type: 'singles' }
        lastFailedAction = null
        episodesGeneration += 1
        const gen = episodesGeneration
        set({
          level: { kind: 'episodes', scope },
          episodes: [],
          episodesOffset: 0,
          episodesTotal: 0,
          episodesHasMore: false,
        })
        await runEpisodesFetch(() => fetchEpisodesPage(scope, true, gen), gen)
      },

      async loadMoreEpisodes() {
        const { level, episodesLoading } = get()
        if (level.kind !== 'episodes') return
        // Ignore a second "Mehr laden" while the first page is still in
        // flight (code review finding I1, scenario A) - without this, two
        // concurrent fetches would both read the same stale offset, both
        // append (duplicate tiles), and whichever resolves last would
        // silently overwrite offset/total/hasMore computed from that same
        // stale offset. Same scope for the whole call, so no generation
        // bump - this is a same-generation guard, not a staleness check.
        if (episodesLoading) return
        await runEpisodesFetch(() => fetchEpisodesPage(level.scope, false, episodesGeneration), episodesGeneration)
      },

      async retry() {
        if (lastFailedAction) await lastFailedAction()
      },

      back() {
        // Drop a stale episodes-retry action too, and bump the generation
        // so a fetch still in flight for the scope being left can't land on
        // the series level's state either - see episodesGeneration's doc.
        lastFailedAction = null
        episodesGeneration += 1
        set({
          level: { kind: 'series' },
          episodes: [],
          episodesError: null,
          episodesHasMore: false,
          episodesOffset: 0,
          episodesTotal: 0,
        })
      },
    }
  })

  return store
}

export type LibraryStateApi = ReturnType<typeof createLibraryState>
