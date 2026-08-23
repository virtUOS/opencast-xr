import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { MediaList } from './MediaList'
import { toEpisodeTile } from './libraryState'
import { createSeriesState } from './seriesState'

const RETRY_LABEL = 'Erneut versuchen'

// Mirrors ChaptersWindow.tsx's slot exactly, on the opposite flank - see
// that file's doc comment for why az +-55/elevation -26 doesn't collide
// with any video window this app actually exercises.
const SERIES_AZIMUTH_DEG = 55
const PANEL_ELEVATION_DEG = -26

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
 * Player-mode window listing the currently open episode's series - only
 * rendered while `episode.seriesId` is set. Reuses `MediaList` DIRECTLY
 * with no wrapper tile type: its API was already kept generic enough for
 * this by Task 11 (`LibraryWindow.tsx`'s own doc comment says as much),
 * and `toEpisodeTile` (also Task 11, from `libraryState.ts`) already
 * produces exactly the tile shape this window needs - duration+date
 * subtitle, "nicht abspielbar" suffix for a non-playable recording - so
 * there is nothing series-specific to add on top of it.
 *
 * The current episode is highlighted (`MediaList`'s `activeId`), and its
 * click is short-circuited to a no-op HERE rather than inside MediaList:
 * MediaList has no opinion on what "select" means (see its own doc comment
 * on `activeId`), so "the current one is not clickable" is this window's
 * policy, not a generic feature. Clicking any OTHER (playable) episode
 * calls `store.openEpisode`, which - per spec, and store.ts's own doc
 * comment on the swap - never autoplays: the new episode lands paused at 0.
 *
 * Fetching/pagination for the series' own episode list lives in the pure,
 * unit-tested `seriesState.ts` (its own small zustand store, one per
 * mount - same pattern `LibraryWindow.tsx` uses for `libraryState.ts`).
 */
export function SeriesWindow({ store }: { store: PlayerStoreApi }) {
  // `client` is fixed for the store's whole lifetime (see player/store.ts),
  // so this memo never re-fires after the first render.
  const client = useStore(store, (s) => s.client)
  const seriesStore = useMemo(() => createSeriesState(client), [client])

  const seriesId = useStore(store, (s) => s.episode?.seriesId)
  const currentEpisodeId = useStore(store, (s) => s.episode?.id)

  // Re-fetches whenever the open episode's seriesId changes. In practice
  // that only happens once per mount (this window only ever lists the
  // CURRENTLY open episode's own series - switching within it via the tiles
  // below keeps the same seriesId), but keying on it rather than firing
  // once on mount keeps this correct if that ever changes, at no cost.
  useEffect(() => {
    if (seriesId) void seriesStore.getState().load(seriesId)
  }, [seriesStore, seriesId])

  const episodes = useStore(seriesStore, (s) => s.episodes)
  const loading = useStore(seriesStore, (s) => s.loading)
  const error = useStore(seriesStore, (s) => s.error)
  const hasMore = useStore(seriesStore, (s) => s.hasMore)

  // Same "keyed by id, retry keeps retrying the SAME episode" rationale as
  // LibraryWindow.tsx's own openError state.
  const [openError, setOpenError] = useState<{ id: string; message: string } | null>(null)

  const selectEpisode = useCallback(
    (id: string) => {
      if (id === currentEpisodeId) return // "not clickable" - see this file's doc comment
      setOpenError(null)
      store.getState().openEpisode(id).catch((err: unknown) => {
        setOpenError({ id, message: err instanceof Error ? err.message : String(err) })
      })
    },
    [store, currentEpisodeId],
  )

  const items = useMemo(() => episodes.map(toEpisodeTile), [episodes])

  // Defensive only: App.tsx gates mounting this window on
  // `episode.seriesId != null` already - see this component's own doc
  // comment.
  if (!seriesId) return null

  return (
    <Window
      id="series"
      title="Reihe"
      size={{ width: 30, height: 30 }}
      position={{ azimuth: SERIES_AZIMUTH_DEG, elevation: PANEL_ELEVATION_DEG }}
    >
      <Container flexGrow={1} flexDirection="column">
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
        {loading && episodes.length === 0 ? (
          <Text fontSize={14} color="#9a9aa5" margin={12}>Lade Reihe...</Text>
        ) : error ? (
          <ErrorPanel message={error} onRetry={() => void seriesStore.getState().retry()} />
        ) : (
          <MediaList
            items={items}
            onSelect={selectEpisode}
            activeId={currentEpisodeId}
            // Same "omitted, not just disabled, while a page is already
            // loading" rationale as LibraryWindow.tsx's own onMore.
            onMore={hasMore && !loading ? () => void seriesStore.getState().loadMore() : undefined}
            moreLabel="Mehr laden"
            emptyText="Keine weiteren Aufzeichnungen dieser Reihe."
          />
        )}
      </Container>
    </Window>
  )
}
