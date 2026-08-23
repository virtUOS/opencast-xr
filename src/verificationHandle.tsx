import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { PlayerStoreApi } from './player/store'

/**
 * Publishes the r3f store on `window.__opencastPlayer` so the scene can be
 * driven and measured from the browser console.
 *
 * This is not decoration, it is the only way this project can verify anything
 * on screen. No VR session is reachable from the automation environment, so
 * every visual claim has to be made against the desktop canvas — and r3f 9
 * keeps its store inside its own reconciler container, reachable from neither
 * the DOM fiber tree nor the canvas element (v8's `canvas.__r3f` is gone). The
 * automation tab is also permanently `document.hidden`, which pauses
 * requestAnimationFrame, so frames have to be forced by hand: `advance()` is
 * exactly the escape hatch r3f provides for that, and `pump()` wraps it.
 *
 * Costs one `useThree` subscription and two window properties, in a demo app.
 * (Renamed from the demo's `window.__sphereShellDemo` — same mechanism, see
 * apps/demo/src/App.tsx's `VerificationHandle`.)
 *
 * `store` is also published (not just the r3f internals) so verification can
 * drive `mode` transitions from the console — e.g.
 * `window.__opencastPlayer.store.getState().toBrowse()` — before Task 11/12
 * give the UI its own controls for that.
 */
export function VerificationHandle({ store }: { store: PlayerStoreApi }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const advance = useThree((s) => s.advance)
  useEffect(() => {
    const api = {
      gl,
      scene,
      camera,
      advance,
      store,
      pump: (n = 6) => {
        for (let i = 0; i < n; i++) advance(performance.now() + i * 16, true)
      },
      /**
       * One numeric snapshot of every stream and its element, for the video
       * window / sync-engine verification (Task 12): drift is
       * `sample()[i].currentTime` differences, `masterId` plus `muted` is the
       * audio handover, and a stream whose `open` is false must report no
       * element at all - the store destroys it (src dropped, load(), removed
       * from the DOM), which is what "really unload" means.
       */
      sample: () => {
        const state = store.getState()
        return {
          masterId: state.engine.masterId,
          playing: state.engine.playing,
          // The store's reactive mirror of the line above - the value the
          // dock's Play/Pause icon is derived from. Reported separately so a
          // disagreement between the two (the stale-mirror defect the final
          // review found) is visible in one snapshot instead of inferred.
          storePlaying: state.playing,
          stalled: state.stalled,
          currentTimeS: state.currentTimeS,
          domVideos: document.querySelectorAll('video').length,
          streams: state.streams.map((s) => {
            const el = state.getElement(s.flavorType)
            return {
              flavorType: s.flavorType,
              open: s.open,
              error: s.error ?? null,
              src: el?.getAttribute('src') ?? null,
              currentTime: el?.currentTime ?? null,
              muted: el?.muted ?? null,
              paused: el?.paused ?? null,
              readyState: el?.readyState ?? null,
              playbackRate: el?.playbackRate ?? null,
            }
          }),
        }
      },
    }
    ;(window as unknown as Record<string, unknown>).__opencastPlayer = api
    return () => {
      delete (window as unknown as Record<string, unknown>).__opencastPlayer
    }
  }, [gl, scene, camera, advance, store])
  return null
}
