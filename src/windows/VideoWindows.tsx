import { useEffect, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import {
  DECORATIVE_POINTER_EVENTS,
  VideoSurface,
  Window,
  useShellStore,
  useWindowState,
} from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { describeMediaError } from '../player/mediaElements'
import {
  VIDEO_ASPECT,
  libraryReturnTarget,
  streamErrorEscapeHint,
  streamWindowAction,
  videoWindowId,
  videoWindowPlacement,
} from './videoWindowState'

/**
 * Keeps ONE flavor's shell window and its stream in agreement, in both
 * directions.
 *
 * The shell is the source of truth for "is this window on screen" and the
 * player store is the source of truth for "is this stream loaded", and the two
 * can be changed independently: the X button and the dock both write only the
 * shell's flag (sphere-shell has no `onRestore` callback - a dock-tile click
 * just clears `closed`), while `closeStream`/`reopenStream` write only the
 * store's. So this watches the shell entry and pushes any disagreement into
 * the store - which is what makes a dock restore reload the stream at all.
 *
 * It also owns the EPISODE-SWAP reset, and this is the layer that has to: the
 * player store rebuilds `streams` on `openEpisode` but has no access to the
 * shell store (created inside `<WindowShell>` and reachable only through React
 * context), so a flavor the user closed in the previous episode would keep its
 * stale `closed: true` shell flag and the rules below would unload the new
 * recording's stream the moment it arrived. Giving the store a shell dependency
 * to fix that would invert the layering; noticing the swap here - where both
 * stores are already in hand - does not. See `streamWindowAction`'s
 * `episodeChanged`.
 *
 * The decision itself is `streamWindowAction` (pure, unit-tested); this hook is
 * only the subscription and the dispatch. Every action it can take is
 * idempotent (`closeStream`/`reopenStream` no-op when already in that state,
 * `restore` is a plain state write), so a double effect invocation is harmless.
 */
function useStreamWindowSync(store: PlayerStoreApi, flavorType: string): void {
  const shellStore = useShellStore()
  const id = videoWindowId(flavorType)
  const entry = useWindowState(id)
  const streamOpen = useStore(store, (s) => s.streams.find((x) => x.flavorType === flavorType)?.open)
  // `canClose` is a pure derivation over `streams` returning a primitive, so
  // calling it inside the selector neither churns renders nor mutates.
  const canClose = useStore(store, (s) => s.canClose(flavorType))
  const episodeId = useStore(store, (s) => s.episode?.id)

  // Which episode the last DISPATCH was made for. Seeded with the current one,
  // so a window mounting into an episode is not itself a swap (its shell entry
  // was just registered and is clean by construction). Compared during render
  // and advanced in the effect below - the same prop-vs-previous pattern
  // sphere-shell's own <Window> uses for its size/position sync.
  const dispatchedForEpisode = useRef(episodeId)
  const episodeChanged = dispatchedForEpisode.current !== episodeId

  const action = streamWindowAction({
    shell: entry ? { closed: entry.closed, minimized: entry.minimized } : undefined,
    streamOpen,
    canClose,
    episodeChanged,
  })

  useEffect(() => {
    dispatchedForEpisode.current = episodeId
    switch (action) {
      case 'reset-window':
        // Stale flag from the PREVIOUS episode's window. Clearing it is all
        // this step does: the next evaluation sees a clean entry, `streams`
        // untouched, and falls through to the normal rules.
        shellStore.getState().restore(id)
        break
      case 'close-stream':
        store.getState().closeStream(flavorType)
        break
      case 'reopen-stream':
        store.getState().reopenStream(flavorType)
        break
      case 'exit-to-library': {
        // The last open stream's window: the store still refuses to unload it
        // (`closeStream`'s own `canClose` gate, unchanged), but instead of
        // undoing the shell's close - the OLD veto, which flashed the window
        // straight back open - this now ACCEPTS the close as the signal to
        // leave player mode entirely: „Wenn beim letzten Video das x zum
        // fenster schließen gedrückt wird, sollte man in die vorherige
        // Auswahl zurück kommen." `episode` is read BEFORE `toBrowse` clears
        // it - `libraryReturnTarget` needs its `seriesId`/`seriesTitle` to
        // pick the series' own episode list over the "Einzelaufzeichnungen"
        // singles group.
        //
        // `toBrowse` is the EXACT SAME path the dock breadcrumb's Home crumb
        // uses (`DockTransport.tsx`'s `onCrumb`): stop ticking, pause the
        // engine, tear down every stream's element, flip `mode` - so there is
        // no separate stop/pause logic to keep in sync with that path, and no
        // orphaned audio.
        //
        // Deliberately NOT `shellStore.getState().restore(id)` (the old
        // veto's fix): restoring a window that is about to unmount anyway
        // would fight the teardown below for nothing - `toBrowse` empties
        // `streams`, which is what actually unmounts every video window (and,
        // per sphere-shell, unregisters their shell entries and dock tiles -
        // see `VideoWindow`'s own doc comment on why a window stays mounted
        // while closed at all). Nothing here needs to touch the shell store
        // directly; the mode switch above does it by unmounting this whole
        // subtree, the same mechanism `useStartClosed.ts`'s doc comment
        // describes for "a window that has left the registry comes back as a
        // NEW one" - so the next episode's windows register clean, with no
        // stale flag for `episodeChanged`'s 'reset-window' step to even need
        // to clear.
        const ep = store.getState().episode
        store.getState().toBrowse(ep ? libraryReturnTarget(ep) : undefined)
        break
      }
      case 'none':
        break
    }
    // `action` is recomputed from current state on every render, and every
    // branch above makes the two states agree - so the next evaluation is
    // 'none' and this cannot loop. `episodeId` is a dependency in its own
    // right: an 'episodeChanged' round that needs no reset yields 'none', and
    // the ref above still has to be advanced for it.
  }, [action, episodeId, store, shellStore, flavorType, id])
}

/**
 * Turns one stream element's fatal `error` event into the store's per-stream
 * error state (spec §9: "Engine pausiert alle; betroffenes Fenster zeigt
 * Fehlerkachel mit Neuladen").
 *
 * This layer, and not the store, is where the listener belongs: the store
 * creates the elements but has no lifecycle hook to hang a DOM subscription
 * off, while this component already re-renders precisely when the element for
 * its flavor changes (see `VideoWindows`' doc comment on `getElement`), which
 * is exactly the effect dependency needed.
 *
 * An element that is ALREADY in its error state when the effect runs is
 * reported too: `error` is a one-shot event with no replay, and the request can
 * fail between `createStreamElement` and this effect (a 404 answered from cache
 * is enough), which would otherwise leave a window silently black forever.
 * `reportStreamError` deduplicates by message, so re-reporting the same failure
 * after a re-render is harmless.
 */
function useStreamErrorWatch(
  store: PlayerStoreApi,
  flavorType: string,
  element: HTMLVideoElement | undefined,
): void {
  useEffect(() => {
    if (!element) return
    const report = () =>
      store.getState().reportStreamError(flavorType, element, describeMediaError(element.error))
    element.addEventListener('error', report)
    if (element.error) report()
    return () => element.removeEventListener('error', report)
  }, [store, flavorType, element])
}

const ERROR_BG = '#3a2028'
const ERROR_TEXT = '#ffd8de'
const ERROR_HINT_TEXT = '#d0a0ac'
const RELOAD_BG = '#542c38'
const RELOAD_BG_HOVER = '#6a3a48'
// „Neu laden" per the spec's own wording, in plain ASCII letters - see
// LibraryWindow.tsx's BACK_LABEL for the missing-glyph defect that rules out
// typographic punctuation in this uikit version's default font.
const RELOAD_LABEL = 'Neu laden'

/**
 * What a video window shows instead of its picture once its stream has failed:
 * the concrete cause, one button that rebuilds the stream, and - only when this
 * is the last open stream - the way out if rebuilding does not help
 * (`streamErrorEscapeHint`; that stream's window cannot be closed, so the tile
 * has to say what can be done instead).
 *
 * Mirrors `LibraryWindow`'s `ErrorPanel` (same palette, same "cause + retry"
 * shape) rather than sharing it, because that one is a full-width panel inside
 * a scroll column while this one has to fill a 16:9 frame - and duplicating
 * twelve lines of uikit layout is cheaper than a props-driven abstraction over
 * two callers with different geometry.
 */
function StreamErrorTile({
  message, hint, onReload,
}: {
  message: string
  hint: string | null
  onReload: () => void
}) {
  return (
    <Container
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={10}
      padding={12}
      backgroundColor={ERROR_BG}
    >
      <Text fontSize={12} color={ERROR_TEXT}>{message}</Text>
      <Container
        paddingX={12}
        paddingY={6}
        borderRadius={6}
        backgroundColor={RELOAD_BG}
        // Always a plain object, never a conditional `undefined` - see
        // ControlsWindow.tsx's doc comment on the uikit reconciler crash.
        hover={{ backgroundColor: RELOAD_BG_HOVER }}
        onClick={(e) => {
          e.stopPropagation()
          onReload()
        }}
      >
        {/* Hit-transparent - see sphere-shell's DECORATIVE_POINTER_EVENTS.
            This one matters: it is the only way out of a failed stream. */}
        <Text fontSize={12} color={ERROR_TEXT} pointerEvents={DECORATIVE_POINTER_EVENTS}>
          {RELOAD_LABEL}
        </Text>
      </Container>
      {hint != null && <Text fontSize={10} color={ERROR_HINT_TEXT}>{hint}</Text>}
    </Container>
  )
}

/**
 * One stream's video window.
 *
 * Rendered for EVERY stream, open or closed - not only the open ones. A closed
 * stream's window has to stay mounted because the shell's dock tile IS the
 * window's own entry: unmounting `<Window>` unregisters it, which would delete
 * the very tile the user needs to click to get the stream back. The shell
 * already hides a `closed` (or `minimized`) window itself, so a mounted
 * `<Window>` for a closed stream draws nothing.
 *
 * `element` is passed in rather than read here: see `VideoWindows`.
 */
function VideoWindow({
  store, flavorType, index, streamCount, element, error,
}: {
  store: PlayerStoreApi
  flavorType: string
  index: number
  /**
   * How many streams the open recording has. Part of the PLACEMENT, not just
   * bookkeeping: a lone stream gets the whole comfortable arc and a pair splits
   * it - see `videoWindowPlacement`.
   */
  streamCount: number
  element: HTMLVideoElement | undefined
  error: string | undefined
}) {
  useStreamWindowSync(store, flavorType)
  useStreamErrorWatch(store, flavorType, element)
  const placement = useMemo(() => videoWindowPlacement(index, streamCount), [index, streamCount])
  // Only the error tile reads this (a primitive derivation over `streams`, so
  // subscribing to it costs nothing when no error is showing).
  const canClose = useStore(store, (s) => s.canClose(flavorType))

  return (
    <Window
      id={videoWindowId(flavorType)}
      title={flavorType}
      size={placement.size}
      aspect={VIDEO_ASPECT}
      position={placement.position}
      // Redundant with useStreamWindowSync above, and deliberately kept: it
      // unloads the stream in the SAME commit as the shell's close, so there
      // is no frame in which a window is gone while its stream still decodes.
      // The hook remains the primary mechanism (it is the only one that sees a
      // close that did not come through this button, and the only one that
      // sees a restore at all).
      onClose={() => store.getState().closeStream(flavorType)}
    >
      {/* The error tile REPLACES the picture rather than overlaying it: a
          failed element has no frames to show anyway, and the tile has to be
          the thing that catches the pointer for its button.

          No element while the stream is closed. VideoSurface never touches
          playback, so unmounting it (minimize, close) does not stop the video -
          it only drops the texture. */}
      {error != null ? (
        <StreamErrorTile
          message={error}
          hint={streamErrorEscapeHint(canClose)}
          onReload={() => store.getState().reloadStream(flavorType)}
        />
      ) : element ? (
        <VideoSurface src={element} />
      ) : null}
    </Window>
  )
}

/**
 * Player mode's video windows: one per stream of the open episode, in
 * `selectStreams` order (presenter, presentation, then alphabetical), which is
 * also the engine's preference order - so window 0 is the stream the engine
 * prefers as master.
 *
 * The `<video>` elements are NOT created here. The store owns them (it creates
 * one per open stream and registers it with the sync engine, keyed by
 * flavorType); this component only asks for the current one. That read has to
 * happen HERE rather than inside `VideoWindow`, because `getElement` is a plain
 * getter and not reactive state: subscribing to `streams` - whose array
 * identity changes on every mutation that swaps an element (`openEpisode`,
 * `closeStream`, `reopenStream`) - is what guarantees the getter is re-read
 * afterwards. A child subscribing to its own `open` flag instead would keep a
 * destroyed element across an episode swap, where `open` stays `true` for a
 * flavor present in both episodes while the element behind it is replaced.
 */
export function VideoWindows({ store }: { store: PlayerStoreApi }) {
  const streams = useStore(store, (s) => s.streams)
  return (
    <>
      {streams.map((stream, index) => (
        <VideoWindow
          key={stream.flavorType}
          store={store}
          flavorType={stream.flavorType}
          index={index}
          streamCount={streams.length}
          element={stream.open ? store.getState().getElement(stream.flavorType) : undefined}
          error={stream.error}
        />
      ))}
    </>
  )
}
