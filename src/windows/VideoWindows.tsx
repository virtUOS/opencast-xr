import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { VideoSurface, Window, useShellStore, useWindowState } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import {
  VIDEO_ASPECT,
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

  const action = streamWindowAction({
    shell: entry ? { closed: entry.closed, minimized: entry.minimized } : undefined,
    streamOpen,
    canClose,
  })

  useEffect(() => {
    switch (action) {
      case 'close-stream':
        store.getState().closeStream(flavorType)
        break
      case 'reopen-stream':
        store.getState().reopenStream(flavorType)
        break
      case 'veto-close':
        // The last open stream: the store refuses to unload it, so the shell's
        // close has to be undone. sphere-shell 0.3.0's <Window> has no
        // `closable` prop, so the X button cannot be hidden from here - see
        // streamWindowAction's doc comment.
        shellStore.getState().restore(id)
        break
      case 'none':
        break
    }
    // `action` is recomputed from current state on every render, and every
    // branch above makes the two states agree - so the next evaluation is
    // 'none' and this cannot loop.
  }, [action, store, shellStore, flavorType, id])
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
  store, flavorType, index, element,
}: {
  store: PlayerStoreApi
  flavorType: string
  index: number
  element: HTMLVideoElement | undefined
}) {
  useStreamWindowSync(store, flavorType)
  const placement = useMemo(() => videoWindowPlacement(index), [index])

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
      {/* No element while the stream is closed. VideoSurface never touches
          playback, so unmounting it (minimize, close) does not stop the video -
          it only drops the texture. */}
      {element ? <VideoSurface src={element} /> : null}
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
          element={stream.open ? store.getState().getElement(stream.flavorType) : undefined}
        />
      ))}
    </>
  )
}
