import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { UNSAFE_useXRStore, type XRControllerState } from '@react-three/xr'
import type { PlayerStoreApi } from '../player/store'
import {
  INITIAL_FLICK_STATE,
  INITIAL_PRESS_LATCH,
  INITIAL_STICK_SEEK_STATE,
  chapterSeekTarget,
  stepChapterFlick,
  stepPressLatch,
  stepStickSeek,
  type FlickState,
  type PressLatchState,
  type StickSeekState,
} from '../player/xrPlayerInput'

/**
 * The player's VR controller bindings, as an R3F null component: it renders
 * nothing and only runs a `useFrame`.
 *
 * | Input | Action |
 * |---|---|
 * | Left stick, left/right | scrub the position — faster the further it is pushed; seeks on release |
 * | Left stick, up/down (a deliberate flick) | one chapter back / forward |
 * | **A** (right) or **X** (left) | play/pause |
 * | **B** (right), held ~1 s | recenter — sphere-shell's, not this component's |
 *
 * All the logic that could be wrong lives in `player/xrPlayerInput.ts`, pure
 * and unit-tested; this file is the glue that reads a gamepad and writes to the
 * store, and is deliberately boring enough to be verified by reading. Same
 * split, and the same reason for it, as `timelineDrag.ts`/`DockTransport.tsx`:
 * no XR session is reachable in this project's automated environment.
 *
 * ## Why the app reads the controller itself
 *
 * Because sphere-shell must not know what „pause" means. The library owns
 * locomotion and reads exactly two things — the RIGHT thumbstick and the one
 * face button bound to recenter. Everything else on the controllers is the
 * application's, and this is the documented way to take it (see the library's
 * README, "The recenter button, and sharing the controllers with your app").
 *
 * The one place the two genuinely collide is the right controller's face
 * buttons: there are only two, and the user wants A for play/pause. That is
 * resolved on the LIBRARY side by `<WindowShell recenterButton="b-button">` in
 * `App.tsx`, not by this component racing it — with the default binding, one
 * press of A would both toggle playback here and start a recenter hold there.
 *
 * ## Why `UNSAFE_useXRStore` and not `useXRInputSourceState`
 *
 * Verified against the installed `@react-three/xr@6.6.30`, exactly as
 * `XRControls` documents: `useXR` (dist/xr.js) calls the THROWING
 * `useXRStore()`, and `useXRInputSourceState` (dist/input.js) is implemented as
 * `useXR((s) => s.inputSourceStates.find(...))`, so it throws too — both would
 * crash a component with no `<XR>` ancestor. `UNSAFE_useXRStore()` returns
 * `undefined` instead, and the underlying store is a plain zustand *vanilla*
 * store, so `.getState()` inside `useFrame` needs no React subscription and
 * costs no re-render. This component is only ever mounted inside `<XR>` today,
 * but it inherits the same discipline rather than being the one place that
 * would break if that changed.
 *
 * ## The desktop (magic window) is unaffected
 *
 * With no session there are no `inputSourceStates`, so every axis reads 0,
 * every button reads not-pressed, and the frame does nothing at all. The
 * `!hasSession` branch additionally RESETS the three state machines, so a
 * gesture interrupted by taking the headset off cannot resume days later
 * against a different recording.
 */
export function XRPlayerControls({ store }: { store: PlayerStoreApi }) {
  const xrStore = UNSAFE_useXRStore()
  const seek = useRef<StickSeekState>(INITIAL_STICK_SEEK_STATE)
  const flick = useRef<FlickState>(INITIAL_FLICK_STATE)
  const playPause = useRef<PressLatchState>(INITIAL_PRESS_LATCH)

  useFrame((_, delta) => {
    const xr = xrStore?.getState()
    if (!xr?.session) {
      // Leaving a session mid-scrub must not leave the HUD showing a preview
      // that nothing will ever commit or clear.
      if (seek.current.targetS !== null) {
        seek.current = INITIAL_STICK_SEEK_STATE
        store.getState().setSeekPreview(null)
      }
      flick.current = INITIAL_FLICK_STATE
      playPause.current = INITIAL_PRESS_LATCH
      return
    }

    const controllers = xr.inputSourceStates
    const byHand = (handedness: 'left' | 'right') =>
      controllers.find(
        (s): s is XRControllerState =>
          s.type === 'controller' && s.inputSource.handedness === handedness,
      )
    const left = byHand('left')
    const right = byHand('right')
    const stick = left?.gamepad['xr-standard-thumbstick']

    // Play/pause: A (right) and X (left) are ONE control, so a single latch
    // over their disjunction — pressing both at once toggles once. Through the
    // store's `setPlaying`, which is the app's only writer of play intent (see
    // store.ts), so the dock's button and this stay in step by construction.
    const primaryPressed =
      right?.gamepad['a-button']?.state === 'pressed' ||
      left?.gamepad['x-button']?.state === 'pressed'
    const { state: nextLatch, fire: togglePlay } = stepPressLatch(playPause.current, primaryPressed)
    playPause.current = nextLatch
    if (togglePlay) {
      const state = store.getState()
      state.setPlaying(!state.playing)
    }

    const { episode, currentTimeS, seekPreviewS } = store.getState()
    if (!episode) return // browse mode, or before the first recording opened

    // Chapter flick (vertical). Evaluated BEFORE the scrub so that a diagonal
    // push that clears the flick threshold resolves as the chapter jump and
    // abandons any scrub in progress — one gesture, one outcome. Without that,
    // the abandoned scrub would commit its own seek on release and silently
    // undo the chapter the user just jumped to.
    const { state: nextFlick, steps } = stepChapterFlick(flick.current, stick?.yAxis ?? 0)
    flick.current = nextFlick
    if (steps !== 0) {
      // From the SCRUB target when one is in flight, so a flick during a scrub
      // steps from where the viewer is currently pointing rather than from the
      // playhead they have already scrubbed away from.
      const from = seek.current.targetS ?? currentTimeS
      const target = chapterSeekTarget(episode.segments, from, steps)
      if (seek.current.targetS !== null) {
        seek.current = INITIAL_STICK_SEEK_STATE
        store.getState().setSeekPreview(null)
      }
      // `null` = no chapter that way (or no chapters at all): a silent no-op.
      if (target !== null) store.getState().engine.seek(target)
      return
    }

    // Horizontal scrub: preview while held, ONE seek on release — see
    // stepStickSeek's doc comment for why a video element must not be seeked
    // every frame, and note this is the same preview field, and therefore the
    // same HUD and dock feedback, the timeline drag already drives.
    const result = stepStickSeek(seek.current, {
      xAxis: stick?.xAxis ?? 0,
      delta,
      currentTimeS,
      durationS: (episode.durationMs ?? 0) / 1000,
    })
    seek.current = result.state
    if (result.preview !== null) store.getState().setSeekPreview(result.preview)
    if (result.commit !== null) {
      store.getState().engine.seek(result.commit)
      // Only clear a preview if one is actually showing: a `setSeekPreview(null)`
      // on a store that already holds null still pushes a new state object at
      // every subscriber, and this runs every frame.
      if (seekPreviewS !== null) store.getState().setSeekPreview(null)
    }
  })

  return null
}
