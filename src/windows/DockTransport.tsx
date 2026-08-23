import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { ThreeEvent } from '@react-three/fiber'
import { Container, Text, type VanillaContainer } from '@react-three/uikit'
import { Library, LoaderCircle, Pause, Play } from '@react-three/uikit-lucide'
import type { PlayerStoreApi } from '../player/store'
import {
  derivePlaybackVisualState,
  fractionToSeconds,
  secondsToFraction,
  transportTimeParts,
} from './transportState'
import {
  type DragEffect,
  type DragState,
  initialDragState,
  rayToTrackFraction,
  reduceDrag,
} from './timelineDrag'

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
 * All the fraction<->time math, the time label's shape, the play/pause
 * button's visible state, the ray->fraction plane math, and the drag
 * gesture's own state machine live in the pure, unit-tested
 * `transportState.ts`/`timelineDrag.ts` - this component is deliberately
 * thin glue over them (same split as `libraryState.ts`/`LibraryWindow.tsx`
 * and `videoWindowState.ts`/`VideoWindows.tsx`).
 *
 * ## The timeline's drag math - see `timelineDrag.ts` for the fix history
 *
 * uikit 1.0.74 has no Slider primitive (per the brief), so the track is a
 * plain `Container` and dragging is hand-rolled. Every pointer event is
 * turned into a `fraction: number | null` via `rayToTrackFraction` (reading
 * `e.ray`, NOT `e.point` - see that function's doc comment for exactly why
 * `e.point` silently breaks under pointer capture), then fed into
 * `reduceDrag`'s pure state machine, whose `effects` this component just
 * executes: `capture`/`release` call `setPointerCapture`/
 * `releasePointerCapture` on `e.target`, `preview`/`commit` write to the
 * store (`setSeekPreview` / `engine.seek`), `clearPreview` resets it.
 *
 * `stopPropagation` is called eagerly on `pointerdown` (any press on the
 * track area should suppress e.g. a background look-drag starting, even if
 * `reduceDrag` ends up doing nothing with it - a ray-miss `pointerdown`),
 * but only conditionally on `pointermove`/`pointerup` - exactly when
 * `reduceDrag` actually produced effects for THIS pointer - so an unrelated
 * pointer's move/up over the track (rejected by the reducer's own
 * foreign-pointer gating) is left free to propagate normally.
 *
 * The fill bar is given `pointerEvents="none"` so a raycast that lands on
 * the (frontmost) fill overlay - clicking into the already-played portion
 * of the track - still resolves against the same `track` ref rather than a
 * different mesh with its own local frame.
 *
 * ## Nesting depth: NOT the real issue (code review I2 - re-tested)
 *
 * An earlier draft of this component wrapped `[time-text, track, time-text]`
 * in their own row `Container`, with the pointer handlers on the *nested*
 * track. Live testing at the time seemed to show that Container silently
 * never received a hit at all, while sibling buttons one nesting level
 * shallower kept working - so a prior revision "fixed" it by flattening the
 * pointer-handler Container into a direct child of this component's own
 * fragment, with a (then-plausible) theory about hit-order/
 * `pointerEventsOrder` inheritance through an extra layer inside the dock's
 * injected slot.
 *
 * Re-tested after the `e.ray` fix above (code review I2): with the SAME
 * nested-row structure restored and only the ray-based fraction math in
 * place, both a plain click AND a drag - including one continuing well past
 * the track's own edge - registered correctly and landed exactly where
 * expected (verified live: a right-edge-overshooting drag seeked to the
 * full episode duration; a left-edge-overshooting one seeked to 0). So the
 * nesting depth was never the real mechanism - the original "clicks
 * silently stop registering" observation was almost certainly this same
 * `e.point`-freezes-under-capture bug (see `timelineDrag.ts`), which can
 * make a genuinely-received event resolve to a wildly wrong (or, in some
 * intermediate states, effectively unusable) fraction and look indistinguishable
 * from "no hit at all" during quick manual testing. There is no depth
 * constraint on this component's JSX; nest the track however reads best.
 *
 * ## KNOWN LIMITATION: scrubbing is flat-plane-only, wrong under EXPERIMENTAL curved mode
 *
 * (Code review round 2.) The dock participates in sphere-shell's
 * EXPERIMENTAL cylindrical bend (`Dock.tsx` calls `useCylindricalBend` on its
 * own group, and its in-scene "Curved" toggle can turn it on at runtime
 * regardless of `App.tsx`'s initial `curved` prop to `<WindowShell>`) - and
 * `rayToTrackFraction` always intersects the real ray against the track's
 * FLAT `matrixWorld` plane, with no bend correction. That is CORRECT for the
 * default, shipped, hardware-validated flat mode (`curved={false}`), where
 * there is no bend to correct for. It is WRONG whenever the dock is curved.
 *
 * This is a **regression for a plain click specifically** versus the
 * pre-round-1 code, which read `e.point`: uikit's own hit-testing
 * (`patchRaycastForBend` in sphere-shell) substitutes a bend-corrected ray
 * before calling the stock flat-quad raycast, so the `Intersection.point` it
 * records IS already bend-corrected - accurate for a plain click. But that
 * substitution is undone (the real ray's direction is restored) in a
 * `finally` block before any handler runs, specifically so `e.ray` stays the
 * TRUE, uncorrected ray for everyone else - which is exactly the field this
 * component now reads, for the unrelated (and more serious) reason that
 * `e.point` freezes solid during a pointer-captured drag (see
 * `timelineDrag.ts`). There is no reading of `e.ray`/`e.point` that is
 * simultaneously bend-aware AND capture-safe without doing the bend math
 * ourselves - which is exactly what a proper fix needs to do.
 *
 * **Why it isn't fixed here.** A correct fix means intersecting `e.ray`
 * against the actual CYLINDER the dock is bent onto (the analogue of
 * `useDragOnSphere` intersecting the shell sphere) and mapping the hit back
 * to this track's own local X. That cylinder's axis and radius are defined
 * in the DOCK's own bend-group local frame (`Dock.tsx`'s internal
 * `groupRef`, fed to `useCylindricalBend` - NOT the shell's `anchorRef`,
 * which is a different, unrotated ancestor: the dock sits at its own
 * `panelTransform({azimuth: 0, elevation: DOCK_ELEVATION}, ...)` offset from
 * the anchor, and a nonzero elevation TILTS the dock's local Y away from the
 * anchor's/world's vertical - so building the cylinder from `anchorRef`
 * alone would use the wrong axis orientation). Nothing sphere-shell exports
 * today reaches that group, its `matrixWorld`, or the live `BendUniforms`
 * `useCylindricalBend` computes for it, from code rendered inside the
 * `dockControls` slot - `useShellContext()` exposes only `anchorRef`, and
 * the dock's own bend transform is private to `Dock.tsx`. Reconstructing it
 * by duplicating `Dock.tsx`'s private layout constants would ALSO still be
 * short one more unknown - this track's own horizontal offset within the
 * dock's flex row, which depends on the live widths of every tile/button
 * to its left and cannot be derived without literally re-running uikit's
 * flex layout. Flagged to the task's controller as `NEEDS_CONTEXT` rather
 * than shipped as a silent approximation; see `docs/UIKIT-NOTES.md` entry 4
 * for the full ray-vs-point-vs-bend story and
 * `.superpowers/sdd/2026-08-23-opencast-player/task-13-report.md` for the
 * exact missing-API proposal.
 *
 * **Practical effect today:** in flat mode (default), scrubbing is exact.
 * In curved mode, a click/drag still moves the fill and seeks in the right
 * DIRECTION and stays monotonic, but the landed time is off by an amount
 * that grows with how far the track sits from the dock's own azimuthal
 * centre and with the bend angle - most noticeable near the track's own
 * edges. Not a crash, not a stuck/frozen preview (that specific bug is
 * fixed) - a `curved`-only numeric inaccuracy.
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
  // Known cosmetic gap (code review, fix round 1): `LoaderCircle` is a
  // static glyph here - no spin animation - so a stall reads as "a
  // different icon" rather than "loading". Animating it would need a
  // per-frame rotation on the icon's own object3D (useFrame), which is out
  // of scope for this pass; left as a follow-up, not silently unnoticed.
  const PlayPauseIcon = visual === 'play' ? Play : visual === 'loading' ? LoaderCircle : Pause

  // Non-null while dragging: shown/scrubbed instead of the real
  // `currentTimeS`, exactly as `seekPreviewS`'s own doc comment in store.ts
  // describes ("HUD feedback only") - here that HUD is this readout+fill.
  const displayTimeS = seekPreviewS ?? currentTimeS
  const fillFraction = secondsToFraction(displayTimeS, durationS)
  const { current: currentLabel, total: totalLabel } = transportTimeParts(displayTimeS, durationS)

  const trackRef = useRef<VanillaContainer | null>(null)
  // Mutable, not React state: a drag gesture's own bookkeeping (which
  // pointer, its last fraction) needs to be read-then-written synchronously
  // within a single event handler, exactly like `useDragOnSphere`'s own
  // refs - re-rendering on every intermediate move would be wasted work the
  // preview's OWN store subscription already causes anyway.
  const dragStateRef = useRef<DragState>(initialDragState)

  const resolveFraction = useCallback((e: ThreeEvent<PointerEvent>): number | null => {
    const track = trackRef.current
    if (!track) return null
    return rayToTrackFraction(e.ray.origin, e.ray.direction, track.matrixWorld)
  }, [])

  const applyEffects = useCallback(
    (effects: DragEffect[], e: ThreeEvent<PointerEvent>) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'capture':
            ;(e.target as Element).setPointerCapture?.(effect.pointerId)
            break
          case 'release':
            ;(e.target as Element).releasePointerCapture?.(effect.pointerId)
            break
          case 'preview':
            store.getState().setSeekPreview(fractionToSeconds(effect.fraction, durationS))
            break
          case 'commit':
            store.getState().engine.seek(fractionToSeconds(effect.fraction, durationS))
            break
          case 'clearPreview':
            store.getState().setSeekPreview(null)
            break
        }
      }
    },
    [store, durationS],
  )

  const onTrackPointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      // Eager and unconditional - see the doc comment above.
      e.stopPropagation()
      const fraction = resolveFraction(e)
      const { state, effects } = reduceDrag(dragStateRef.current, {
        type: 'pointerdown',
        pointerId: e.pointerId,
        fraction,
      })
      dragStateRef.current = state
      applyEffects(effects, e)
    },
    [resolveFraction, applyEffects],
  )

  const onTrackPointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const fraction = resolveFraction(e)
      const { state, effects } = reduceDrag(dragStateRef.current, {
        type: 'pointermove',
        pointerId: e.pointerId,
        fraction,
      })
      dragStateRef.current = state
      if (effects.length > 0) e.stopPropagation()
      applyEffects(effects, e)
    },
    [resolveFraction, applyEffects],
  )

  const onTrackPointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const fraction = resolveFraction(e)
      const { state, effects } = reduceDrag(dragStateRef.current, {
        type: 'pointerup',
        pointerId: e.pointerId,
        fraction,
      })
      dragStateRef.current = state
      if (effects.length > 0) e.stopPropagation()
      applyEffects(effects, e)
    },
    [resolveFraction, applyEffects],
  )

  const onTrackPointerCancel = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const { state, effects } = reduceDrag(dragStateRef.current, { type: 'pointercancel', pointerId: e.pointerId })
      dragStateRef.current = state
      applyEffects(effects, e)
    },
    [applyEffects],
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

      <Container height={30} flexDirection="row" alignItems="center" gap={8}>
        <Text fontSize={11} color="#cfd8ff">{currentLabel}</Text>
        <Container
          ref={trackRef}
          width={TRACK_WIDTH_PX}
          height={TRACK_HEIGHT_PX}
          borderRadius={TRACK_HEIGHT_PX / 2}
          backgroundColor="#33333d"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          onPointerCancel={onTrackPointerCancel}
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
        <Text fontSize={11} color="#cfd8ff">{totalLabel}</Text>
      </Container>

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
