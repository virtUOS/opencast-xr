import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { UNSAFE_useXRStore, type XRControllerState } from '@react-three/xr'
import type { PlayerStoreApi } from '../player/store'
import type { OcSegment } from '../opencast/types'
import {
  INITIAL_XR_PLAYER_INPUT_STATE,
  stepPlayerFrame,
  type XRPlayerInputState,
} from '../player/xrPlayerInput'

/** Stable empty array, so a resting frame in browse mode allocates nothing. */
const NO_SEGMENTS: OcSegment[] = []

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
 * Every decision — including the interactions BETWEEN the three bindings — lives
 * in `player/xrPlayerInput.ts`'s `stepPlayerFrame`, a pure
 * `(state, input) -> { state, effects }` reducer. This file reads a gamepad,
 * calls it, and executes the effects. Same split, and the same reason for it,
 * as `timelineDrag.ts`/`DockTransport.tsx`: no XR session is reachable in this
 * project's automated environment.
 *
 * The one thing that split cannot cover is whether this file hands the reducer
 * the RIGHT inputs — and that was where the round's worst bug lived (the
 * `engine.currentTime` comment below). So there is also
 * `XRPlayerControls.test.tsx`, which drives this component against a real store
 * with `useFrame`/`UNSAFE_useXRStore` mocked.
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
  const input = useRef<XRPlayerInputState>(INITIAL_XR_PLAYER_INPUT_STATE)

  useFrame((_, delta) => {
    const xr = xrStore?.getState()
    const state = store.getState()

    const controllers = xr?.inputSourceStates ?? []
    const byHand = (handedness: 'left' | 'right') =>
      controllers.find(
        (s): s is XRControllerState =>
          s.type === 'controller' && s.inputSource.handedness === handedness,
      )
    const left = byHand('left')
    const right = byHand('right')
    const stick = left?.gamepad['xr-standard-thumbstick']

    const { state: next, effects } = stepPlayerFrame(input.current, {
      hasSession: !!xr?.session,
      hasEpisode: state.episode != null,
      xAxis: stick?.xAxis ?? 0,
      yAxis: stick?.yAxis ?? 0,
      // A (right) and X (left) are ONE control — see stepPressLatch.
      primaryPressed:
        right?.gamepad['a-button']?.state === 'pressed' ||
        left?.gamepad['x-button']?.state === 'pressed',
      delta,
      // `engine.currentTime`, NOT the store's `currentTimeS`. This is
      // load-bearing and was a real bug: the store's field is a mirror
      // refreshed by a 250 ms interval (`tickOnce`), so for up to a quarter
      // second after ANY seek it still reports the position the viewer just
      // left. A gesture based on it would scrub away from a stale point and
      // commit a seek back towards it — which made a chapter flick undo itself
      // via its own return path, made a quick reverse scrub cancel the seek
      // before it, and made a second flick a no-op. The engine's getter reads
      // the master element, which `SyncEngine.seek` writes synchronously, so it
      // is correct on the very next frame. Pinned by XRPlayerControls.test.tsx,
      // which never ticks the mirror at all.
      currentTimeS: state.engine.currentTime,
      durationS: (state.episode?.durationMs ?? 0) / 1000,
      segments: state.episode?.segments ?? NO_SEGMENTS,
      previewS: state.seekPreviewS,
    })
    input.current = next

    // Every decision was made above; this is execution only. Read through
    // `store.getState()` each time rather than the `state` snapshot, since an
    // earlier effect in the same frame may have moved it.
    for (const effect of effects) {
      switch (effect.type) {
        case 'togglePlay': {
          const live = store.getState()
          live.setPlaying(!live.playing)
          break
        }
        case 'preview':
          store.getState().setSeekPreview(effect.seconds)
          break
        case 'clearPreview':
          store.getState().setSeekPreview(null)
          break
        case 'seek':
          store.getState().engine.seek(effect.seconds)
          break
      }
    }
  })

  return null
}
