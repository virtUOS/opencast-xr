// @vitest-environment jsdom
//
// `XRPlayerControls` — the WIRING, against a REAL player store and a real
// `SyncEngine`.
//
// ## Why this file exists at all, when the logic is already unit-tested
//
// `player/xrPlayerInput.ts` is pure and covered, but its `stepPlayerFrame`
// takes `currentTimeS` as an argument — so every test there proves only that
// the reducer uses the clock it is HANDED. The bug this file exists for was
// the component handing it the wrong one: `store.currentTimeS` is a mirror
// refreshed by a 250 ms interval (`tickOnce`), while `engine.currentTime` reads
// the master element and is written synchronously by `SyncEngine.seek`. Reading
// the mirror meant that for up to a quarter of a second after any seek, the
// next gesture based itself on a position the viewer had already left — so a
// chapter jump could be silently undone, and a second flick was a no-op.
//
// No pure test can catch that, because the substitution happens at the call
// site. This one can: it uses a real store whose two clocks genuinely diverge,
// deliberately never calls `tickOnce`, and asserts on where the engine ends up.
//
// ## How the component is driven without a Canvas
//
// `useFrame` and `UNSAFE_useXRStore` are the only two things tying it to a live
// R3F/WebXR tree, and both are mocked: the first captures the frame callback so
// the test can step it by hand, the second returns a fake XR store whose
// `inputSourceStates` are plain objects in `@pmndrs/xr`'s own shape. Everything
// below that — the player store, the engine, the reducer — is the real thing.
//
// React's own `act` + `createRoot`, matching `useStartClosed.test.tsx`; this
// app has no `@testing-library/react` dependency.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { OpencastClient } from '../opencast/client'
import type { Episode, OcSegment } from '../opencast/types'
import { createPlayerStore, type PlayerStoreApi } from '../player/store'

/** The captured `useFrame` callback, set when the component renders. */
let frameCallback: ((state: unknown, delta: number) => void) | null = null

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => {
    frameCallback = callback
  },
}))

/** One controller's gamepad, in `@pmndrs/xr`'s `XRControllerState` shape. */
interface FakeController {
  type: 'controller'
  inputSource: { handedness: 'left' | 'right' }
  gamepad: Record<string, { state?: string; xAxis?: number; yAxis?: number } | undefined>
}

let xrState: { session: object | null; inputSourceStates: FakeController[] } = {
  session: {},
  inputSourceStates: [],
}

vi.mock('@react-three/xr', () => ({
  UNSAFE_useXRStore: () => ({ getState: () => xrState }),
}))

// Imported AFTER the mocks are registered (vi.mock is hoisted, but keeping the
// import here documents the dependency).
const { XRPlayerControls } = await import('./XRPlayerControls')

const SEGMENTS: OcSegment[] = [
  { startMs: 0, durationMs: 60_000, text: 'Eins' },
  { startMs: 60_000, durationMs: 60_000, text: 'Zwei' },
  { startMs: 120_000, durationMs: 60_000, text: 'Drei' },
]

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep-1',
    title: 'Test',
    durationMs: 600_000,
    tracks: [],
    segments: SEGMENTS,
    ...overrides,
  } as Episode
}

let container: HTMLDivElement
let root: Root
let store: PlayerStoreApi

function mount(ep: Episode = episode()) {
  store = createPlayerStore({} as OpencastClient)
  // Straight into player mode. `openEpisode` would need a whole fake client and
  // real <video> elements to reach the same state, and none of that is what is
  // under test here - the engine below is deliberately left EMPTY, which is
  // what makes its clock a plain `lastKnownTime` that `seek` writes
  // synchronously and nothing else touches.
  store.setState({ mode: 'player', episode: ep })
  act(() => {
    root.render(<XRPlayerControls store={store} />)
  })
  return store
}

/** One frame, with the left stick and buttons in the given position. */
function frame(
  options: { x?: number; y?: number; a?: boolean; xButton?: boolean; delta?: number } = {},
) {
  xrState = {
    session: {},
    inputSourceStates: [
      {
        type: 'controller',
        inputSource: { handedness: 'left' },
        gamepad: {
          'xr-standard-thumbstick': { xAxis: options.x ?? 0, yAxis: options.y ?? 0 },
          'x-button': { state: options.xButton ? 'pressed' : 'default' },
        },
      },
      {
        type: 'controller',
        inputSource: { handedness: 'right' },
        gamepad: {
          'xr-standard-thumbstick': { xAxis: 0, yAxis: 0 },
          'a-button': { state: options.a ? 'pressed' : 'default' },
        },
      },
    ],
  }
  act(() => {
    frameCallback?.(null, options.delta ?? 0.1)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  frameCallback = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  store?.getState().dispose()
})

describe('XRPlayerControls wiring', () => {
  it('mounts, renders nothing, and registers a frame callback', () => {
    mount()
    expect(frameCallback).not.toBeNull()
    expect(container.textContent).toBe('')
  })

  it('C1: reads engine.currentTime, NOT the store mirror, for a chapter flick', () => {
    // The regression this file exists for. Two flicks in a row, with NO
    // tickOnce between them, so `currentTimeS` stays frozen at its initial 0
    // for the whole test. Reading it would resolve both flicks against
    // chapter 1 and land on 60 s twice; reading the engine advances properly.
    const s = mount()
    s.getState().engine.seek(30) // inside chapter 1
    frame({ y: 0 }) // arm the flick

    frame({ y: 1 })
    expect(s.getState().engine.currentTime).toBe(60)

    frame({ y: 0 }) // re-arm
    frame({ y: 1 })
    expect(s.getState().engine.currentTime).toBe(120)

    // Proof the mirror really was stale throughout - i.e. that the test could
    // not have passed by accident.
    expect(s.getState().currentTimeS).toBe(0)
  })

  it('C1: reads engine.currentTime for a fresh scrub gesture', () => {
    // Seek far forward, then scrub back a little without ticking. Based on the
    // stale mirror (0) the gesture would scrub from the start of the recording
    // and commit a seek near 0, throwing the viewer to the beginning.
    const s = mount()
    s.getState().engine.seek(300)
    expect(s.getState().currentTimeS).toBe(0) // mirror is stale by construction

    for (let i = 0; i < 3; i++) frame({ x: -1 })
    frame({ x: 0 }) // release commits

    const landed = s.getState().engine.currentTime
    expect(landed).toBeLessThan(300)
    expect(landed).toBeGreaterThan(280) // 3 frames x 0.1 s x 30 s/s = -9 s
  })

  it('C1: a chapter jump survives the flick\'s own diagonal return path', () => {
    const s = mount()
    s.getState().engine.seek(30)
    frame({ y: 0 })
    frame({ y: 1 })
    expect(s.getState().engine.currentTime).toBe(60)

    // The thumb comes back through the horizontal deadzone.
    frame({ x: 0.9, y: 0.7 })
    frame({ x: 0.6, y: 0.4 })
    frame({ x: 0.35, y: 0.2 })
    frame({ x: 0, y: 0 })

    expect(s.getState().engine.currentTime).toBe(60)
    expect(s.getState().seekPreviewS).toBeNull()
  })

  it('scrubs into seekPreviewS while held and seeks once on release', () => {
    const s = mount()
    s.getState().engine.seek(100)
    for (let i = 0; i < 4; i++) frame({ x: 1 })

    expect(s.getState().seekPreviewS).not.toBeNull()
    expect(s.getState().seekPreviewS!).toBeGreaterThan(100)
    expect(s.getState().engine.currentTime).toBe(100) // NOT seeked yet

    frame({ x: 0 })
    expect(s.getState().seekPreviewS).toBeNull()
    expect(s.getState().engine.currentTime).toBeGreaterThan(100)
  })

  it('toggles play/pause from A and from X, once per press', () => {
    const s = mount()
    expect(s.getState().playing).toBe(false)

    frame({ a: true })
    expect(s.getState().playing).toBe(true)
    for (let i = 0; i < 10; i++) frame({ a: true })
    expect(s.getState().playing).toBe(true) // held, not re-toggled

    frame({ a: false })
    frame({ xButton: true }) // the LEFT controller's X - same control
    expect(s.getState().playing).toBe(false)
  })

  it('I1: a recording with an unparseable duration never seeks to 0', () => {
    // Episode.durationMs is Number(mp?.duration) at the parse boundary.
    const s = mount(episode({ durationMs: NaN }))
    s.getState().engine.seek(200)
    for (let i = 0; i < 4; i++) frame({ x: 1 })
    frame({ x: 0 })

    expect(s.getState().engine.currentTime).toBe(200)
    expect(s.getState().seekPreviewS).toBeNull()
  })

  it('is inert with no session, and clears a preview stranded by one ending', () => {
    const s = mount()
    s.getState().engine.seek(100)
    for (let i = 0; i < 3; i++) frame({ x: 1 })
    expect(s.getState().seekPreviewS).not.toBeNull()

    xrState = { session: null, inputSourceStates: [] }
    act(() => frameCallback?.(null, 0.1))

    expect(s.getState().seekPreviewS).toBeNull()
    expect(s.getState().engine.currentTime).toBe(100) // no commit on the way out
  })

  it('does nothing on a resting frame, including no store writes', () => {
    const s = mount()
    s.getState().engine.seek(100)
    let notifications = 0
    const unsubscribe = s.subscribe(() => notifications++)
    for (let i = 0; i < 10; i++) frame()
    unsubscribe()

    expect(notifications).toBe(0)
    expect(s.getState().engine.currentTime).toBe(100)
  })
})
