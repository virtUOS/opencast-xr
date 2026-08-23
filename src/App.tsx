import { useCallback, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { XR } from '@react-three/xr'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { WindowShell, Window } from 'sphere-shell'
import { SHELL_RADIUS, xrStore } from './xrStore'
import { VerificationHandle } from './verificationHandle'
import { OpencastClient } from './opencast/client'
import { createPlayerStore } from './player/store'

/**
 * Why WebXR is or isn't available, as a short line we can render on screen.
 *
 * Copied from apps/demo/src/App.tsx's `describeXrEnvironment`/`XrStatus`
 * (see that file's doc comment for the full rationale: hiding the button
 * when `navigator.xr` is missing makes "can't start a session" and "still
 * probing" indistinguishable). Trimmed to VR only — the player has no
 * passthrough/background mode (not in the plan; that machinery is
 * demo-specific), so there is nothing here to probe or offer for AR.
 */
type XrStatus =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; reason: string }

function describeXrEnvironment(): XrStatus | null {
  if (!window.isSecureContext) {
    return {
      kind: 'unavailable',
      reason:
        'no secure context — WebXR needs https with a certificate the device trusts (clicking past a warning is not enough), or http://localhost',
    }
  }
  if (!('xr' in navigator) || navigator.xr == null) {
    return { kind: 'unavailable', reason: 'navigator.xr missing — this browser exposes no WebXR API' }
  }
  return null
}

/**
 * Placeholder for browse mode. Task 11 replaces this with the real
 * `src/windows/LibraryWindow.tsx` (series/episode tile list backed by
 * `client.listSeries`/`listEpisodes`); this task only needs the two modes to
 * be visibly distinct on screen.
 */
function LibraryWindow() {
  return (
    <Window id="library" title="Bibliothek" size={{ width: 44, height: 30 }}
            position={{ azimuth: 0, elevation: 0 }}>
      <Container flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" padding={10}>
        <Text fontSize={16} color="#ffffff">Bibliothek (Platzhalter — Task 11)</Text>
      </Container>
    </Window>
  )
}

/**
 * Placeholder for player mode. Task 12 replaces this with the real
 * `src/windows/VideoWindows.tsx` (one `<Window>` per open stream, wired to
 * `store.streams`/`getElement`/`closeStream`/`reopenStream`); this task only
 * needs the two modes to be visibly distinct on screen.
 */
function PlayerWindows() {
  return (
    <Window id="player-placeholder" title="Player" size={{ width: 44, height: 30 }}
            position={{ azimuth: 0, elevation: 0 }}>
      <Container flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" padding={10}>
        <Text fontSize={16} color="#ffffff">Player (Platzhalter — Task 12)</Text>
      </Container>
    </Window>
  )
}

export function App() {
  // One OpencastClient + one PlayerStore per <App> mount, not module-level
  // like xrStore.ts. xrStore has to be module-level because it's imported by
  // sibling modules that need the SAME store identity outside this component
  // (none exist yet, but the demo's dock controls are the precedent). The
  // player store has no such cross-module consumer — everything that touches
  // it lives inside <App>'s own tree — and its `dispose()` is a ONE-SHOT
  // teardown (see store.ts: "not reusable after dispose"), which pairs
  // naturally with a component's mount/unmount rather than a module-level
  // singleton that would either leak its 250ms tick interval across HMR
  // reloads or need its own ad hoc "was it already disposed" guard.
  const client = useMemo(() => new OpencastClient(), [])
  const playerStore = useMemo(() => createPlayerStore(client), [client])
  useEffect(() => {
    return () => playerStore.getState().dispose()
  }, [playerStore])
  const mode = useStore(playerStore, (s) => s.mode)

  const [xrStatus, setXrStatus] = useState<XrStatus>({ kind: 'checking' })
  const [enterError, setEnterError] = useState<string | null>(null)

  useEffect(() => {
    const environment = describeXrEnvironment()
    if (environment) {
      setXrStatus(environment)
      return
    }
    let cancelled = false
    navigator.xr!.isSessionSupported('immersive-vr')
      .then((vr) => {
        if (cancelled) return
        setXrStatus(
          vr
            ? { kind: 'ready' }
            : { kind: 'unavailable', reason: 'browser has WebXR but reports no immersive-vr device' },
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setXrStatus({
          kind: 'unavailable',
          reason: `isSessionSupported threw: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const enterVR = useCallback(() => {
    setEnterError(null)
    void Promise.resolve(xrStore.enterVR()).catch((error: unknown) => {
      setEnterError(`VR konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', zIndex: 1, padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        {xrStatus.kind === 'ready' && (
          <button onClick={enterVR} style={{ padding: '8px 16px' }}>
            VR betreten
          </button>
        )}
        {enterError != null && (
          <span
            style={{
              color: '#ffd8de', background: '#3a2028', border: '1px solid #c04858',
              borderRadius: 4, padding: '6px 10px', font: '12px system-ui, sans-serif',
              maxWidth: '40vw',
            }}
          >
            {enterError}
          </span>
        )}
        {xrStatus.kind !== 'ready' && (
          <span
            style={{
              color: '#e8e8ee',
              background: '#3a2a2a',
              border: '1px solid #6a4a4a',
              borderRadius: 4,
              padding: '6px 10px',
              font: '12px system-ui, sans-serif',
              maxWidth: '60vw',
            }}
          >
            {xrStatus.kind === 'checking'
              ? 'No VR: checking…'
              : `No VR: ${xrStatus.reason} · secureContext=${String(window.isSecureContext)} · navigator.xr=${'xr' in navigator && navigator.xr != null ? 'yes' : 'no'} · ${location.protocol}//${location.hostname}`}
          </span>
        )}
      </div>
      <Canvas camera={{ position: [0, 0, 0.01], fov: 70 }}>
        <VerificationHandle store={playerStore} />
        <color attach="background" args={['#101014']} />
        <ambientLight intensity={1} />
        <XR store={xrStore}>
          <WindowShell
            radius={SHELL_RADIUS}
            curved={false}
            // Task 13 mounts <DockTransport/> here (Play/Pause, timeline+seek,
            // "Bibliothek"-button — player mode only). Left undefined rather
            // than an empty fragment so the dock renders its own default
            // Arrange/Recenter/Exit-VR buttons with no app slot beside them.
            dockControls={undefined}
          >
            {mode === 'browse' ? <LibraryWindow /> : <PlayerWindows />}
          </WindowShell>
        </XR>
      </Canvas>
    </div>
  )
}
