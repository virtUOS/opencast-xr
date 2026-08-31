import { describe, expect, it } from 'vitest'
import { INITIAL_TOUR_GATE_STATE, advanceTourGate, tourStartDecision, type TourGateState } from './tourGate'

describe('advanceTourGate', () => {
  it('reports sessionStarted and marks xrActive on a fresh session start (none -> immersive-vr)', () => {
    const { state, sessionStarted } = advanceTourGate(INITIAL_TOUR_GATE_STATE, 'immersive-vr')
    expect(state).toEqual({ xrActive: true })
    expect(sessionStarted).toBe(true)
  })

  it('reports sessionStarted on none -> immersive-ar too', () => {
    const { state, sessionStarted } = advanceTourGate(INITIAL_TOUR_GATE_STATE, 'immersive-ar')
    expect(sessionStarted).toBe(true)
    expect(state.xrActive).toBe(true)
  })

  it('does not report sessionStarted again while the session stays active', () => {
    const started = advanceTourGate(INITIAL_TOUR_GATE_STATE, 'immersive-vr')
    const stillActive = advanceTourGate(started.state, 'immersive-vr')
    expect(stillActive.sessionStarted).toBe(false)
    expect(stillActive.state).toBe(started.state) // same reference: a genuine no-op
  })

  it('a session ending clears xrActive and reports sessionStarted false', () => {
    const started = advanceTourGate(INITIAL_TOUR_GATE_STATE, 'immersive-vr')
    const ended = advanceTourGate(started.state, 'none')
    expect(ended.state).toEqual({ xrActive: false })
    expect(ended.sessionStarted).toBe(false)
  })

  it('mode staying none is a no-op', () => {
    const result = advanceTourGate(INITIAL_TOUR_GATE_STATE, 'none')
    expect(result.state).toBe(INITIAL_TOUR_GATE_STATE)
    expect(result.sessionStarted).toBe(false)
  })

  it('a full session lifecycle - start, end, start again - reports sessionStarted both times it starts', () => {
    let state: TourGateState = INITIAL_TOUR_GATE_STATE
    let started = advanceTourGate(state, 'immersive-vr')
    expect(started.sessionStarted).toBe(true)
    state = started.state

    const ended = advanceTourGate(state, 'none')
    expect(ended.sessionStarted).toBe(false)
    state = ended.state

    started = advanceTourGate(state, 'immersive-vr')
    expect(started.sessionStarted).toBe(true)
    expect(started.state.xrActive).toBe(true)
  })
})

describe('tourStartDecision', () => {
  it('never starts while mode is not player, regardless of sessionStarted/modeEdge', () => {
    expect(
      tourStartDecision({ sessionStarted: true, modeEdge: false, mode: 'browse', enabled: true }),
    ).toBe(false)
    expect(
      tourStartDecision({
        sessionStarted: false,
        modeEdge: true,
        // modeEdge claiming 'browse'->'player' while mode reports 'browse' is
        // not a real call shape any caller produces, but the guard must not
        // depend on that: `mode` itself is checked, not inferred from the flags.
        mode: 'browse',
        enabled: true,
      }),
    ).toBe(false)
  })

  it('never starts when neither sessionStarted nor modeEdge is true, even in player mode', () => {
    expect(
      tourStartDecision({ sessionStarted: false, modeEdge: false, mode: 'player', enabled: true }),
    ).toBe(false)
  })

  it('starts on modeEdge alone, in player mode', () => {
    expect(
      tourStartDecision({ sessionStarted: false, modeEdge: true, mode: 'player', enabled: true }),
    ).toBe(true)
  })

  it('starts on sessionStarted alone, in player mode - the conference/wiring-gap case', () => {
    expect(
      tourStartDecision({ sessionStarted: true, modeEdge: false, mode: 'player', enabled: true }),
    ).toBe(true)
  })

  it('starts EVERY time - the kiosk rule: no "already shown" suppression left to defer to', () => {
    // Two consecutive mode-edge starts (e.g. two different recordings opened
    // one after another, each via its own browse->player edge) both start it.
    expect(
      tourStartDecision({ sessionStarted: false, modeEdge: true, mode: 'player', enabled: true }),
    ).toBe(true)
    expect(
      tourStartDecision({ sessionStarted: false, modeEdge: true, mode: 'player', enabled: true }),
    ).toBe(true)
  })

  it('is false whenever the tutorial is switched off, regardless of every other flag', () => {
    expect(
      tourStartDecision({ sessionStarted: true, modeEdge: true, mode: 'player', enabled: false }),
    ).toBe(false)
  })
})

/**
 * The kiosk rule, traced end to end through the same two primitives
 * `App.tsx`'s two effects actually call: `advanceTourGate` (the `xrStore`
 * subscription) and `tourStartDecision` (the shared "start it" call both
 * effects funnel through - see `tourGate.ts`'s own doc comment). These are
 * the same four scenarios the wiring-gap fix traced through before - the
 * outcomes for two of them change under the kiosk rule (noted inline).
 */
describe('the kiosk rule - four scenarios, traced through the real call shape', () => {
  /** Simulates the `xrStore.subscribe` effect: advances the gate and reports whether THIS call was a fresh session start. */
  function fireXrModeChange(gate: TourGateState, xrMode: 'none' | 'immersive-vr' | 'immersive-ar') {
    const { state, sessionStarted } = advanceTourGate(gate, xrMode)
    return { gate: state, sessionStarted }
  }

  /** Simulates either effect's shared "start it" call - `App.tsx`'s `maybeStartTour`. */
  function maybeStart(opts: { sessionStarted: boolean; modeEdge: boolean; mode: 'browse' | 'player' }) {
    return tourStartDecision({ ...opts, enabled: true })
  }

  it('scenario 1: headset re-entry with the SAME recording still open (mode never leaves player)', () => {
    let gate: TourGateState = { xrActive: true }
    const mode = 'player'

    // Visitor 1 removes the headset.
    let xr = fireXrModeChange(gate, 'none')
    gate = xr.gate
    expect(maybeStart({ sessionStarted: xr.sessionStarted, modeEdge: false, mode })).toBe(false) // ending a session never starts anything

    // Visitor 2 dons the headset - a FRESH session - while the previous
    // recording is still open.
    xr = fireXrModeChange(gate, 'immersive-vr')
    gate = xr.gate
    expect(xr.sessionStarted).toBe(true)
    expect(maybeStart({ sessionStarted: xr.sessionStarted, modeEdge: false, mode })).toBe(true) // visitor 2 gets the tour
  })

  it('scenario 2: VR entered mid-visit, after the tour already ran once in the magic window', () => {
    let gate = INITIAL_TOUR_GATE_STATE
    const mode: 'browse' | 'player' = 'player'

    // Magic-window visitor opens a recording and sees the tour.
    expect(maybeStart({ sessionStarted: false, modeEdge: true, mode })).toBe(true)

    // WITHOUT leaving player mode (same recording still open), the same
    // visitor puts a headset on - a fresh immersive session starting mid-visit.
    const xr = fireXrModeChange(gate, 'immersive-vr')
    gate = xr.gate
    expect(xr.sessionStarted).toBe(true)
    expect(maybeStart({ sessionStarted: xr.sessionStarted, modeEdge: false, mode })).toBe(true) // a fresh session re-shows it, even with no mode edge
  })

  it('scenario 3: VR entered from browse, THEN a recording is opened - fires exactly once, on the mode edge', () => {
    let gate = INITIAL_TOUR_GATE_STATE
    const modeWhileBrowsing: 'browse' | 'player' = 'browse'

    // Visitor enters VR from the library - no recording open yet.
    const xr = fireXrModeChange(gate, 'immersive-vr')
    gate = xr.gate
    expect(xr.sessionStarted).toBe(true)
    expect(maybeStart({ sessionStarted: xr.sessionStarted, modeEdge: false, mode: modeWhileBrowsing })).toBe(false) // must NOT fire early while still browsing

    // The visitor now opens a recording - the browse->player edge.
    expect(maybeStart({ sessionStarted: false, modeEdge: true, mode: 'player' })).toBe(true) // fires here instead - exactly once
  })

  it('scenario 4: a SECOND recording opened later in the same page load, still no XR session - kiosk change: this NOW also shows', () => {
    // Under the old "once per epoch/page load" rule this second start was
    // suppressed; the kiosk brief explicitly asks for every player start to
    // show it, so both browse->player edges below start the tour.
    expect(maybeStart({ sessionStarted: false, modeEdge: true, mode: 'player' })).toBe(true)
    expect(maybeStart({ sessionStarted: false, modeEdge: true, mode: 'player' })).toBe(true)

    // Staying in player mode without a fresh browse->player edge (e.g. the
    // dock's own previous/next episode buttons) still does not repeat it -
    // this is not a mode edge and not a fresh session, so nothing changed.
    expect(maybeStart({ sessionStarted: false, modeEdge: false, mode: 'player' })).toBe(false)
  })
})
