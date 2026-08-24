import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { MediaList } from './MediaList'
import {
  SINGLES_TILE_ID,
  createLibraryState,
  scopeHeaderLabel,
  seriesTiles,
  toEpisodeTile,
} from './libraryState'

const RETRY_LABEL = 'Erneut versuchen'
// Plain ASCII "<", not "‹" (U+2039): live verification showed uikit's
// default font rendering "‹" as a tofu box - see toEpisodeTile's doc comment
// in libraryState.ts for the same defect and WindowFrame.tsx's precedent.
const BACK_LABEL = '< Zurück'

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Container flexDirection="column" gap={10} padding={12} alignItems="flex-start">
      <Text fontSize={13} color="#ffd8de">{message}</Text>
      <Container
        paddingX={12}
        paddingY={6}
        borderRadius={6}
        backgroundColor="#3a2028"
        hover={{ backgroundColor: '#542c38' }}
        onClick={(e) => {
          e.stopPropagation()
          onRetry()
        }}
      >
        <Text fontSize={12} color="#ffd8de">{RETRY_LABEL}</Text>
      </Container>
    </Container>
  )
}

/**
 * Browse-mode window: level 1 lists series (plus the synthetic
 * "Einzelaufzeichnungen" group), level 2 lists that group's episodes.
 * Selecting a playable episode calls `store.getState().openEpisode(id)` -
 * that's the player store (Task 9), which flips `mode` to 'player' on
 * success. All the fetch/pagination/grouping/playability logic lives in the
 * pure, independently-tested `libraryState.ts`; this component is
 * deliberately thin glue on top of it (see that file's tests - uikit
 * components can't render meaningfully in jsdom, so this file's correctness
 * is verified live, not in a unit test).
 */
export function LibraryWindow({ store }: { store: PlayerStoreApi }) {
  // `client` is fixed for the store's whole lifetime (see store.ts), so this
  // never re-fires after the first render.
  const client = useStore(store, (s) => s.client)
  const libraryStore = useMemo(() => createLibraryState(client), [client])

  useEffect(() => {
    void libraryStore.getState().loadSeries()
  }, [libraryStore])

  // The dock breadcrumb's „Reihe" crumb: browse mode has to open at LEVEL 2,
  // already scoped to that series, instead of at the series list. The intent
  // arrives as the player store's one-shot `browseTarget` (see `BrowseTarget`
  // in player/store.ts) because `toBrowse` runs before this window exists.
  //
  // `consumeBrowseTarget` clears it as it reads, so a re-fired effect or a
  // StrictMode double-invoke cannot enter the series twice (which would be a
  // second, pointless page-1 fetch). `enterSeries` bumps `libraryState`'s own
  // `episodesGeneration`, so this composes with the race-token discipline
  // rather than sidestepping it: the level-1 `loadSeries` above runs
  // concurrently and only ever writes `series`, and if the user navigates away
  // before this fetch lands, its result is discarded like any other stale one.
  //
  // Deliberately separate from the effect above rather than folded into it: the
  // series list still has to be loaded, because „< Zurück" from the scoped
  // level 2 goes to level 1 and must find it populated.
  useEffect(() => {
    const target = store.getState().consumeBrowseTarget()
    if (target) void libraryStore.getState().enterSeries(target.sid, target.title)
  }, [libraryStore, store])

  const level = useStore(libraryStore, (s) => s.level)
  const series = useStore(libraryStore, (s) => s.series)
  const seriesLoading = useStore(libraryStore, (s) => s.seriesLoading)
  const seriesError = useStore(libraryStore, (s) => s.seriesError)
  const episodes = useStore(libraryStore, (s) => s.episodes)
  const episodesLoading = useStore(libraryStore, (s) => s.episodesLoading)
  const episodesError = useStore(libraryStore, (s) => s.episodesError)
  const episodesHasMore = useStore(libraryStore, (s) => s.episodesHasMore)

  // openEpisode (the player store) rejects with an OpencastError and keeps
  // no error field of its own - see store.ts's doc comment on openEpisode:
  // "Task 11's transport/UI layer is expected to catch it". This window is
  // that layer. Keyed by episode id so retrying always retries the SAME
  // episode, even if the tile list has since scrolled or grown via "Mehr
  // laden".
  const [openError, setOpenError] = useState<{ id: string; message: string } | null>(null)

  const selectEpisode = useCallback(
    (id: string) => {
      setOpenError(null)
      store.getState().openEpisode(id).catch((err: unknown) => {
        setOpenError({ id, message: err instanceof Error ? err.message : String(err) })
      })
    },
    [store],
  )

  const seriesItems = useMemo(() => seriesTiles(series), [series])

  const selectSeriesLevelTile = useCallback(
    (id: string) => {
      // Clear a stale "couldn't open episode" banner from whatever scope
      // was showing before - it belongs to that scope, not this one, and
      // without this it would otherwise persist across navigation (code
      // review minor finding: stale openError banner).
      setOpenError(null)
      if (id === SINGLES_TILE_ID) {
        void libraryStore.getState().enterSingles()
        return
      }
      const match = series.find((s) => s.id === id)
      void libraryStore.getState().enterSeries(id, match?.title ?? id)
    },
    [libraryStore, series],
  )

  const episodeItems = useMemo(() => episodes.map(toEpisodeTile), [episodes])

  const selectEpisodeTile = useCallback(
    (id: string) => {
      const tile = episodeItems.find((t) => t.id === id)
      if (!tile?.playable) return // "nicht abspielbar" tiles never call openEpisode
      selectEpisode(id)
    },
    [episodeItems, selectEpisode],
  )

  return (
    <Window id="library" title="Bibliothek" size={{ width: 50, height: 40 }} position={{ azimuth: 0, elevation: 0 }}>
      <Container flexGrow={1} flexDirection="column">
        {level.kind === 'series' ? (
          seriesLoading && series.length === 0 ? (
            <Text fontSize={14} color="#9a9aa5" margin={12}>Lade Reihen...</Text>
          ) : seriesError ? (
            <ErrorPanel message={seriesError} onRetry={() => void libraryStore.getState().retrySeries()} />
          ) : (
            <MediaList items={seriesItems} onSelect={selectSeriesLevelTile} emptyText="Keine Reihen gefunden." />
          )
        ) : (
          <>
            <Container flexDirection="row" alignItems="center" padding={10} gap={10}>
              <Container
                paddingX={4}
                paddingY={2}
                borderRadius={4}
                hover={{ backgroundColor: '#20202a' }}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenError(null) // see selectSeriesLevelTile's comment - same stale-banner fix
                  libraryStore.getState().back()
                }}
              >
                <Text fontSize={13} color="#cfd8ff">{BACK_LABEL}</Text>
              </Container>
              {/* Which scope this level-2 list actually is. `EpisodeScope.title`
                  had been carried since Task 11 without ever being rendered,
                  and the dock breadcrumb made that a real gap: arriving here
                  straight from a „Reihe" crumb, „< Zurück" alone does not say
                  which series you landed in. The dock passes the UNtruncated
                  title for exactly this line - and `scopeHeaderLabel` is what
                  cuts it to one line, like every other string this app renders
                  (see its doc comment for the uikit defect that makes that
                  mandatory rather than cosmetic). */}
              <Text fontSize={13} color="#9a9aa5">{scopeHeaderLabel(level.scope)}</Text>
            </Container>
            {openError && (
              <Container flexDirection="row" alignItems="center" padding={10} gap={10} backgroundColor="#3a2028">
                <Text fontSize={12} color="#ffd8de" flexGrow={1}>{openError.message}</Text>
                <Container
                  paddingX={10}
                  paddingY={4}
                  borderRadius={4}
                  backgroundColor="#542c38"
                  hover={{ backgroundColor: '#6a3a48' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    selectEpisode(openError.id)
                  }}
                >
                  <Text fontSize={12} color="#ffd8de">{RETRY_LABEL}</Text>
                </Container>
              </Container>
            )}
            {episodesLoading && episodes.length === 0 ? (
              <Text fontSize={14} color="#9a9aa5" margin={12}>Lade Aufzeichnungen...</Text>
            ) : episodesError ? (
              <ErrorPanel
                message={episodesError}
                // retryEpisodes, not a shared retry(): this panel and the
                // level-1 one are both reachable while the OTHER kind of fetch
                // is still in flight (the breadcrumb's series crumb starts
                // loadSeries and enterSeries in the same commit), and one
                // shared retry slot let a resolving series load disarm this
                // button - see retrySeries' doc comment in libraryState.ts.
                onRetry={() => void libraryStore.getState().retryEpisodes()}
              />
            ) : (
              <MediaList
                items={episodeItems}
                onSelect={selectEpisodeTile}
                // Omitted (not just guarded) while a page is already loading
                // - the tile disappears rather than staying clickable-but-
                // inert, so there's nothing on screen inviting the double-
                // click the state layer's own loadMoreEpisodes guard already
                // has to defend against (code review finding I1, scenario A).
                onMore={
                  episodesHasMore && !episodesLoading
                    ? () => void libraryStore.getState().loadMoreEpisodes()
                    : undefined
                }
                moreLabel="Mehr laden"
                emptyText="Keine Aufzeichnungen."
              />
            )}
          </>
        )}
      </Container>
    </Window>
  )
}
