import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { MediaList } from './MediaList'
import { SINGLES_TILE_ID, createLibraryState, seriesTiles, toEpisodeTile } from './libraryState'

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
            <ErrorPanel message={seriesError} onRetry={() => void libraryStore.getState().retry()} />
          ) : (
            <MediaList items={seriesItems} onSelect={selectSeriesLevelTile} emptyText="Keine Reihen gefunden." />
          )
        ) : (
          <>
            <Container
              flexDirection="row"
              alignItems="center"
              padding={10}
              gap={8}
              hover={{ backgroundColor: '#20202a' }}
              onClick={(e) => {
                e.stopPropagation()
                libraryStore.getState().back()
              }}
            >
              <Text fontSize={13} color="#cfd8ff">{BACK_LABEL}</Text>
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
              <ErrorPanel message={episodesError} onRetry={() => void libraryStore.getState().retry()} />
            ) : (
              <MediaList
                items={episodeItems}
                onSelect={selectEpisodeTile}
                onMore={episodesHasMore ? () => void libraryStore.getState().loadMoreEpisodes() : undefined}
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
