import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { ThreeEvent } from '@react-three/fiber'
import { Container, Text, type VanillaContainer } from '@react-three/uikit'
import { Library, LoaderCircle, Pause, Play } from '@react-three/uikit-lucide'
import type { PlayerStoreApi } from '../player/store'
import {
  clampFraction,
  derivePlaybackVisualState,
  fractionToSeconds,
  secondsToFraction,
  transportTimeParts,
} from './transportState'

const BUTTON_ICON_PX = 15
const TRACK_WIDTH_PX = 180
const TRACK_HEIGHT_PX = 6

/**
 * The dock's player-mode transport: Play/Pause, a click-and-drag timeline,
 * a time readout, and the "Bibliothek" button back to browse mode.
 *
 * Rendered in `<WindowShell dockControls>` (see `App.tsx`) - App.tsx only
 * mounts this while `mode === 'player'`, which is what makes "Browse mode
 * shows no transport" (the brief's requirement) true; this component does
 * not re-check `mode` itself. Follows the demo's `PlaybackControls`/
 * `BackgroundControl` idiom (`apps/demo/src/App.tsx`): plain uikit
 * `Container`s with `onClick`+`stopPropagation`, sized to the dock's own
 * 30px-tall row.
 *
 * All the fraction<->time math, the time label's shape, and the play/pause
 * button's visible state live in the pure, unit-tested `transportState.ts` -
 * this component is deliberately thin glue over it (same split as
 * `libraryState.ts`/`LibraryWindow.tsx` and `videoWindowState.ts`/
 * `VideoWindows.tsx`).
 *
 * ## The timeline's drag math
 *
 * uikit 1.0.74 has no Slider primitive (per the brief), so the track is a
 * plain `Container` and dragging is hand-rolled - but NOT with
 * `useDragOnSphere`/`useResizeOnSphere`'s sphere-ray-intersection approach:
 * those exist because a *window* moves across the shell's sphere, but the
 * track here is a small, flat element already sitting inside the window's
 * own (already-placed) local content tree, so there is no sphere geometry to
 * intersect in the first place.
 *
 * Instead this uses the fact that every `@pmndrs/uikit` `Component` (what a
 * `Container`'s ref resolves to) is itself a `THREE.Mesh` built on a UNIT
 * plane geometry (`createPanelGeometry()`, a `PlaneGeometry(1, 1)` centered
 * at its own local origin) - the actual on-screen size and position are
 * baked into that mesh's `matrixWorld`, not into the geometry. So
 * `track.worldToLocal(intersectionPoint)` undoes exactly that transform and
 * lands back in the unit box: local x in [-0.5, 0.5] across the track's
 * rendered width, regardless of where the track's window sits on the shell
 * or how it's rotated to face it - no separate width/size lookup needed,
 * and no risk of it going stale if the track is resized. `local.x + 0.5` is
 * therefore already the drag fraction.
 *
 * `pointerId` tracking + `setPointerCapture`/`releasePointerCapture` +
 * `stopPropagation` mirror `useDragOnSphere`'s established, capture-safe
 * pattern (see that file - accepted pointer only tracked between its own
 * down and matching up/cancel). The fill bar is given `pointerEvents="none"`
 * so a raycast that lands on the (frontmost) fill overlay - clicking into the
 * already-played portion of the track - still resolves against the same
 * `track` ref rather than a different mesh with its own local frame.
 *
 * The pointer handlers sit on a `height={30}` Container that is a DIRECT
 * child of this component's own fragment (the same nesting depth as the
 * Play/Pause and "Bibliothek" buttons) - the visible thin bar is a nested
 * child INSIDE it, not the interactive element itself. Live verification
 * (dragging the real dock in the browser, with a debug hook projecting the
 * track's `matrixWorld` corners to screen space to get exact click targets)
 * found that nesting the pointer handlers one level deeper - on the thin bar
 * directly, inside its own wrapping row Container - made the dock silently
 * stop registering clicks on it at all, while the sibling buttons (not
 * nested inside an extra wrapper) kept working. Root cause not fully
 * isolated (plausibly something in how this uikit version's hit-order/
 * pointerEventsOrder is inherited through an extra layer inside the dock's
 * own injected child slot - see `Dock.tsx`'s `DockProps` doc comment), but
 * the fix is simple and has a clear live-verified effect either way: keep
 * the element carrying the pointer handlers a direct child of the slot.
 * `height={30}` also gives the drag target the same comfortable hit height
 * as every other dock button, rather than the 6px visible bar's own height.
 */
export function DockTransport({ store }: { store: PlayerStoreApi }) {
  const episode = useStore(store, (s) => s.episode)
  const currentTimeS = useStore(store, (s) => s.currentTimeS)
  const seekPreviewS = useStore(store, (s) => s.seekPreviewS)
  const stalled = useStore(store, (s) => s.stalled)
  const episodeId = episode?.id
  const durationS = (episode?.durationMs ?? 0) / 1000

  // `engine.playing` is a plain getter, not reactive store state (see
  // syncEngine.ts's doc comment on it) - intent only ever changes from this
  // button's own click, or from `openEpisode`/`toBrowse` forcing a pause
  // (never while THIS component is mounted for browse<->player, since it
  // unmounts across that boundary - App.tsx only renders it in player mode -
  // but a same-mount episode swap, e.g. a future "next episode" action,
  // does force one mid-mount). A plain `useState` seeded from the engine and
  // reset on an episode change stays correct without teaching store.ts a
  // mirrored field just for this button.
  const [intentPlaying, setIntentPlaying] = useState(() => store.getState().engine.playing)
  useEffect(() => {
    setIntentPlaying(false)
  }, [episodeId])

  const togglePlay = useCallback(() => {
    const engine = store.getState().engine
    if (intentPlaying) {
      engine.pause()
      setIntentPlaying(false)
    } else {
      engine.play()
      setIntentPlaying(true)
    }
  }, [store, intentPlaying])

  const visual = derivePlaybackVisualState(intentPlaying, stalled)
  const PlayPauseIcon = visual === 'play' ? Play : visual === 'loading' ? LoaderCircle : Pause

  // Non-null while dragging: shown/scrubbed instead of the real
  // `currentTimeS`, exactly as `seekPreviewS`'s own doc comment in store.ts
  // describes ("HUD feedback only") - here that HUD is this readout+fill.
  const displayTimeS = seekPreviewS ?? currentTimeS
  const fillFraction = secondsToFraction(displayTimeS, durationS)
  const { current: currentLabel, total: totalLabel } = transportTimeParts(displayTimeS, durationS)

  const trackRef = useRef<VanillaContainer | null>(null)
  const draggingRef = useRef(false)
  const activePointerRef = useRef<number | null>(null)

  const fractionFromEvent = useCallback((e: ThreeEvent<PointerEvent>): number | null => {
    const track = trackRef.current
    if (!track) return null
    const local = e.point.clone()
    track.worldToLocal(local)
    return clampFraction(local.x + 0.5)
  }, [])

  const onTrackPointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation()
      const fraction = fractionFromEvent(e)
      if (fraction === null) return
      draggingRef.current = true
      activePointerRef.current = e.pointerId
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      store.getState().setSeekPreview(fractionToSeconds(fraction, durationS))
    },
    [fractionFromEvent, store, durationS],
  )

  const onTrackPointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || e.pointerId !== activePointerRef.current) return
      e.stopPropagation()
      const fraction = fractionFromEvent(e)
      if (fraction === null) return
      store.getState().setSeekPreview(fractionToSeconds(fraction, durationS))
    },
    [fractionFromEvent, store, durationS],
  )

  const onTrackPointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (!draggingRef.current || e.pointerId !== activePointerRef.current) return
      e.stopPropagation()
      draggingRef.current = false
      activePointerRef.current = null
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
      // A real seek on release - the brief's "on pointerup engine.seek(t) +
      // setSeekPreview(null)". Re-derives the fraction from THIS event
      // rather than trusting the last onPointerMove's preview, so a
      // pointerup that lands off-track (still within capture) still seeks to
      // where it actually is; falls back to whatever was already previewed
      // if this particular event can't be resolved (no track ref yet).
      const fraction = fractionFromEvent(e)
      const targetS = fraction === null ? seekPreviewS ?? currentTimeS : fractionToSeconds(fraction, durationS)
      store.getState().engine.seek(targetS)
      store.getState().setSeekPreview(null)
    },
    [fractionFromEvent, store, durationS, seekPreviewS, currentTimeS],
  )

  const onTrackPointerCancel = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (e.pointerId !== activePointerRef.current) return
      draggingRef.current = false
      activePointerRef.current = null
      // No seek on a cancel - the brief: "on pointercancel just clear preview".
      store.getState().setSeekPreview(null)
    },
    [store],
  )

  // Defensive only: App.tsx mounts this exclusively in player mode, which
  // always has an episode by the time `mode` flips (see store.ts's
  // `openEpisode`, which sets both in the same `set()` call).
  if (!episode) return null

  return (
    <>
      <Container
        height={30}
        width={30}
        alignItems="center"
        justifyContent="center"
        backgroundColor="#2f6f4f"
        borderRadius={6}
        hover={{ backgroundColor: '#3f9f6f' }}
        onClick={(e) => {
          e.stopPropagation()
          togglePlay()
        }}
      >
        <PlayPauseIcon width={BUTTON_ICON_PX} height={BUTTON_ICON_PX} color="#ffffff" />
      </Container>

      <Text fontSize={11} color="#cfd8ff">{currentLabel}</Text>
      <Container
        ref={trackRef}
        height={30}
        alignItems="center"
        width={TRACK_WIDTH_PX}
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerCancel}
      >
        <Container
          width={TRACK_WIDTH_PX}
          height={TRACK_HEIGHT_PX}
          borderRadius={TRACK_HEIGHT_PX / 2}
          backgroundColor="#33333d"
        >
          <Container
            positionType="absolute"
            positionLeft={0}
            positionTop={0}
            width={Math.round(TRACK_WIDTH_PX * fillFraction)}
            height={TRACK_HEIGHT_PX}
            borderRadius={TRACK_HEIGHT_PX / 2}
            backgroundColor="#6f9fff"
            pointerEvents="none"
          />
        </Container>
      </Container>
      <Text fontSize={11} color="#cfd8ff">{totalLabel}</Text>

      <Container
        height={30}
        paddingX={10}
        gap={6}
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        backgroundColor="#2f4f6f"
        borderRadius={6}
        hover={{ backgroundColor: '#3f6f9f' }}
        onClick={(e) => {
          e.stopPropagation()
          store.getState().toBrowse()
        }}
      >
        <Library width={BUTTON_ICON_PX} height={BUTTON_ICON_PX} color="#ffffff" />
        <Text fontSize={12} color="#ffffff">Bibliothek</Text>
      </Container>
    </>
  )
}
