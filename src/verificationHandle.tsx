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
    }
    ;(window as unknown as Record<string, unknown>).__opencastPlayer = api
    return () => {
      delete (window as unknown as Record<string, unknown>).__opencastPlayer
    }
  }, [gl, scene, camera, advance, store])
  return null
}
