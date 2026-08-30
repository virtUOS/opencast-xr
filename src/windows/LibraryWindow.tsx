import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { ChevronLeft } from '@react-three/uikit-lucide'
import { List } from '@react-three/uikit-lucide'
import { DECORATIVE_POINTER_EVENTS, Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { MediaList } from './MediaList'
import {
  SINGLES_TILE_ID,
  createLibraryState,
  scopeHeaderLabel,
  seriesTiles,
  toEpisodeTile,
} from './libraryState'
import { useCapturedPress } from './useCapturedPress'

const RETRY_LABEL = 'Erneut versuchen'
const BACK_LABEL = 'Zurück'

/**
 * User feedback from a real Quest 3 session: „der Zurück-Button ist sehr
 * schwer zu treffen und auch schlecht zu sehen, ob er gehighlighted ist."
 * The old control was a bare `<Text>` in a 4/2 px-padded box - a ~60x17 px
 * target, and its hover went from no background at all to `#20202a`, a tone
 * close enough to the window's own background to be nearly invisible through
 * a headset lens.
 *
 * Sized to `BACK_BUTTON_HEIGHT_PX` (44, matching sphere-shell's
 * `RESIZE_GRIP_HIT_PX` - the codebase's own precedent for "a hit target
 * enlarged past its visual affordance because a controller ray needs the
 * room"), with an explicit resting background and a hover that jumps to a
 * saturated blue with real contrast against it - the same
 * bright-hover-on-dark-resting idiom `DockTransport.tsx`'s `IconButton` uses
 * for its ACTIVE state, chosen deliberately over the more subtle breadcrumb-
 * crumb hover because THIS is the control the previous round's feedback was
 * about.
 *
 * Icon + label are both `DECORATIVE_POINTER_EVENTS` so the whole visual
 * button is one hit target - see `DockTransport.tsx`'s `IconButton` doc
 * comment: a press on the glyph and a release on the label are two different
 * `Object3D`s, and `@pmndrs/pointer-events` only emits `click` when press and
 * release resolve to the SAME one.
 *
 * Presses are pointer-captured (`useCapturedPress`), not `onClick` - a
 * drifting Quest ray must not lose the press once it lands here either; see
 * `pressCapture.ts`'s own doc comment for the full reasoning (the same fix
 * applied to `DockTransport.tsx`'s `IconButton`).
 */
const BACK_BUTTON_HEIGHT_PX = 44
const BACK_BG = '#22222c'
const BACK_BG_HOVER = '#3f6f9f'

function BackButton({ onPress }: { onPress: () => void }) {
  const press = useCapturedPress(onPress)
  return (
    <Container
      height={BACK_BUTTON_HEIGHT_PX}
      paddingX={16}
      gap={8}
      flexDirection="row"
      alignItems="center"
      borderRadius={8}
      backgroundColor={BACK_BG}
      hover={{ backgroundColor: BACK_BG_HOVER }}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
    >
      <ChevronLeft width={16} height={16} color="#cfd8ff" pointerEvents={DECORATIVE_POINTER_EVENTS} />
      <Text fontSize={14} color="#cfd8ff" pointerEvents={DECORATIVE_POINTER_EVENTS}>
        {BACK_LABEL}
      </Text>
    </Container>
  )
}

// Also enlarged as part of the same feedback round (see BackButton's doc
// comment above): same class of offender - a small text-only target - even
// though this one wasn't the one named in the report. paddingY 6 -> 14 takes
// it from a ~26 px to a ~40 px tall target; the hover colors themselves
// already had real contrast (`#3a2028` -> `#542c38`) so those are unchanged.
function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  const press = useCapturedPress(onRetry)
  return (
    <Container flexDirection="column" gap={10} padding={12} alignItems="flex-start">
      <Text fontSize={13} color="#ffd8de">{message}</Text>
      <Container
        paddingX={16}
        paddingY={14}
        borderRadius={6}
        backgroundColor="#3a2028"
        hover={{ backgroundColor: '#542c38' }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerCancel={press.onPointerCancel}
      >
        {/* The label covers nearly the whole button, and a press and release
            that resolve to two different objects is not a click - see
            sphere-shell's DECORATIVE_POINTER_EVENTS. */}
        <Text fontSize={12} color="#ffd8de" pointerEvents={DECORATIVE_POINTER_EVENTS}>
          {RETRY_LABEL}
        </Text>
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

  // Two producers of a one-shot `browseTarget` land here: the dock
  // breadcrumb's „Reihe" crumb (`kind: 'series'`) and closing the LAST open
  // video window (`kind: 'singles'` for a series-less recording, `'series'`
  // for one with a series - `videoWindowState.ts`'s `libraryReturnTarget`).
  // Both need browse mode to open at LEVEL 2 already scoped, instead of at
  // the series list. The intent arrives as the player store's one-shot
  // `browseTarget` (see `BrowseTarget` in player/store.ts) because `toBrowse`
  // runs before this window exists.
  //
  // `consumeBrowseTarget` clears it as it reads, so a re-fired effect or a
  // StrictMode double-invoke cannot enter the scope twice (which would be a
  // second, pointless page-1 fetch). `enterSeries`/`enterSingles` bump
  // `libraryState`'s own `episodesGeneration`, so this composes with the
  // race-token discipline rather than sidestepping it: the level-1
  // `loadSeries` above runs concurrently and only ever writes `series`, and
  // if the user navigates away before this fetch lands, its result is
  // discarded like any other stale one.
  //
  // Deliberately separate from the effect above rather than folded into it: the
  // series list still has to be loaded, because „Zurück" from the scoped
  // level 2 goes to level 1 and must find it populated.
  useEffect(() => {
    const target = store.getState().consumeBrowseTarget()
    if (!target) return
    if (target.kind === 'series') void libraryStore.getState().enterSeries(target.sid, target.title)
    else void libraryStore.getState().enterSingles()
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

  // Called unconditionally (hooks can't live inside `{openError && ...}`
  // JSX) - the guard on `openError` moves inside the callback instead. Same
  // pointer-captured press as `BackButton`/`ErrorPanel` above; see
  // `pressCapture.ts`'s doc comment.
  const retryOpenError = useCapturedPress(() => {
    if (openError) selectEpisode(openError.id)
  })

  // User feedback: „Serien haben glaube ich nie ein Vorschaubild." True by
  // construction, not a fetch bug - the Search API's `/series` endpoint
  // returns Dublin Core (`id`/`title` only, see `parseSeries` in
  // `opencast/parse.ts`), no attachments at all, so a series `imageUrl` could
  // never exist without an extra per-series request this window doesn't (and
  // per the brief, must not) make. `MediaList`'s old fallback for a missing
  // `imageUrl` was a plain grey box meant for a thumbnail that SHOULD be
  // there - exactly wrong for something that never will be, hence the
  // designed `placeholderIcon` panel instead. `List` matches the icon the
  // dock breadcrumb already uses for "this leads to a list of episodes" (see
  // `DockTransport.tsx`'s `opensSeries` crumb), so a series-shaped tile reads
  // the same way in both places.
  const seriesItems = useMemo(
    () => seriesTiles(series).map((tile) => ({ ...tile, placeholderIcon: List })),
    [series],
  )

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
              <BackButton
                onPress={() => {
                  setOpenError(null) // see selectSeriesLevelTile's comment - same stale-banner fix
                  libraryStore.getState().back()
                }}
              />
              {/* Which scope this level-2 list actually is. `EpisodeScope.title`
                  had been carried since Task 11 without ever being rendered,
                  and the dock breadcrumb made that a real gap: arriving here
                  straight from a „Reihe" crumb, „Zurück" alone does not say
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
                  // Same same-class fix as ErrorPanel's retry button above -
                  // paddingY 4 -> 14.
                  paddingX={14}
                  paddingY={14}
                  borderRadius={4}
                  backgroundColor="#542c38"
                  hover={{ backgroundColor: '#6a3a48' }}
                  onPointerDown={retryOpenError.onPointerDown}
                  onPointerUp={retryOpenError.onPointerUp}
                  onPointerCancel={retryOpenError.onPointerCancel}
                >
                  <Text fontSize={12} color="#ffd8de" pointerEvents={DECORATIVE_POINTER_EVENTS}>
                    {RETRY_LABEL}
                  </Text>
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
