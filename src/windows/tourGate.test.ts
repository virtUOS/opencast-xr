import { describe, expect, it } from 'vitest'
import {
  INITIAL_TOUR_GATE_STATE,
  advanceTourGateEpoch,
  markTourShown,
  shouldShowTour,
  tourStartDecision,
  type TourGateState,
} from './tourGate'

describe('advanceTourGateEpoch', () => {
  it('bumps the epoch and marks xrActive on a fresh session start (none -> immersive-vr)', () => {
    const next = advanceTourGateEpoch(INITIAL_TOUR_GATE_STATE, 'immersive-vr')
    expect(next).toEqual({ epoch: 1, xrActive: true, shownForEpoch: null })
  })

  it('bumps the epoch on none -> immersive-ar too', () => {
    const next = advanceTourGateEpoch(INITIAL_TOUR_GATE_STATE, 'immersive-ar')
    expect(next.epoch).toBe(1)
    expect(next.xrActive).toBe(true)
  })

  it('does not bump the epoch again while the session stays active', () => {
    const started = advanceTourGateEpoch(INITIAL_TOUR_GATE_STATE, 'immersive-vr')
    const stillActive = advanceTourGateEpoch(started, 'immersive-vr')
    expect(stillActive).toBe(started) // same reference: a genuine no-op
  })

  it('a session ending clears xrActive but does not touch the epoch', () => {
    const started = advanceTourGateEpoch(INITIAL_TOUR_GATE_STATE, 'immersive-vr')
    const ended = advanceTourGateEpoch(started, 'none')
    expect(ended).toEqual({ epoch: 1, xrActive: false, shownForEpoch: null })
  })

  it('mode staying none is a no-op', () => {
    expect(advanceTourGateEpoch(INITIAL_TOUR_GATE_STATE, 'none')).toBe(INITIAL_TOUR_GATE_STATE)
  })

  it('a full session lifecycle - start, end, start again - bumps the epoch twice', () => {
    let state = INITIAL_TOUR_GATE_STATE
    state = advanceTourGateEpoch(state, 'immersive-vr')
    expect(state.epoch).toBe(1)
    state = advanceTourGateEpoch(state, 'none')
    expect(state.epoch).toBe(1)
    state = advanceTourGateEpoch(state, 'immersive-vr')
    expect(state.epoch).toBe(2)
    expect(state.xrActive).toBe(true)
  })

  it('preserves shownForEpoch across every transition - only the tour-shown bookkeeping changes that', () => {
    const shown: TourGateState = { epoch: 0, xrActive: false, shownForEpoch: 0 }
    const started = advanceTourGateEpoch(shown, 'immersive-vr')
    expect(started.shownForEpoch).toBe(0)
  })
})

describe('shouldShowTour', () => {
  it('is false whenever the tutorial is switched off, regardless of epoch/shownForEpoch', () => {
    expect(shouldShowTour(INITIAL_TOUR_GATE_STATE, false)).toBe(false)
    expect(shouldShowTour({ epoch: 3, xrActive: true, shownForEpoch: null }, false)).toBe(false)
  })

  it('is true the first time in a fresh epoch (never shown before)', () => {
    expect(shouldShowTour(INITIAL_TOUR_GATE_STATE, true)).toBe(true)
  })

  it('is false once the tour has already been shown for the current epoch', () => {
    const shown: TourGateState = { epoch: 0, xrActive: false, shownForEpoch: 0 }
    expect(shouldShowTour(shown, true)).toBe(false)
  })

  it('is true again once the epoch has moved on from the one it was shown for', () => {
    const shownForOldEpoch: TourGateState = { epoch: 1, xrActive: true, shownForEpoch: 0 }
    expect(shouldShowTour(shownForOldEpoch, true)).toBe(true)
  })
})

describe('markTourShown', () => {
  it('records the CURRENT epoch as shown', () => {
    const state: TourGateState = { epoch: 2, xrActive: true, shownForEpoch: null }
    expect(markTourShown(state)).toEqual({ epoch: 2, xrActive: true, shownForEpoch: 2 })
  })

  it('overwrites a stale shownForEpoch from an earlier epoch', () => {
    const state: TourGateState = { epoch: 2, xrActive: true, shownForEpoch: 0 }
    expect(markTourShown(state)).toEqual({ epoch: 2, xrActive: true, shownForEpoch: 2 })
  })
})

describe('the full magic-window story - once per page load', () => {
  it('shows on the first player-mode entry, then never again in the same (epoch-0) page load', () => {
    let gate = INITIAL_TOUR_GATE_STATE
    expect(shouldShowTour(gate, true)).toBe(true)
    gate = markTourShown(gate)

    // A second recording opened later in the same tab, still no XR session.
    expect(shouldShowTour(gate, true)).toBe(false)
    // ...and a third.
    expect(shouldShowTour(gate, true)).toBe(false)
  })
})

describe('the full VR story - every fresh session re-shows it', () => {
  it('shows once per session, and again for the next visitor after a fresh session start', () => {
    let gate = INITIAL_TOUR_GATE_STATE

    // Visitor 1 puts the headset on.
    gate = advanceTourGateEpoch(gate, 'immersive-vr')
    expect(shouldShowTour(gate, true)).toBe(true)
    gate = markTourShown(gate)

    // Visitor 1 opens a second recording in the same session - no repeat.
    expect(shouldShowTour(gate, true)).toBe(false)

    // Visitor 1 takes the headset off.
    gate = advanceTourGateEpoch(gate, 'none')

    // Visitor 2 puts it on - a fresh session.
    gate = advanceTourGateEpoch(gate, 'immersive-vr')
    expect(shouldShowTour(gate, true)).toBe(true)
  })
})

describe('tourStartDecision', () => {
  const shownState: TourGateState = { epoch: 1, xrActive: true, shownForEpoch: 1 }

  it('never starts while mode is not player, regardless of epochChanged/modeEdge', () => {
    expect(
      tourStartDecision({
        epochChanged: true,
        modeEdge: false,
        mode: 'browse',
        enabled: true,
        gateState: INITIAL_TOUR_GATE_STATE,
      }),
    ).toBe(false)
    expect(
      tourStartDecision({
        epochChanged: false,
        modeEdge: true,
        // modeEdge claiming 'browse'->'player' while mode reports 'browse' is
        // not a real call shape any caller produces, but the guard must not
        // depend on that: `mode` itself is checked, not inferred from the flags.
        mode: 'browse',
        enabled: true,
        gateState: INITIAL_TOUR_GATE_STATE,
      }),
    ).toBe(false)
  })

  it('never starts when neither epochChanged nor modeEdge is true, even in player mode with an unshown epoch', () => {
    expect(
      tourStartDecision({
        epochChanged: false,
        modeEdge: false,
        mode: 'player',
        enabled: true,
        gateState: INITIAL_TOUR_GATE_STATE,
      }),
    ).toBe(false)
  })

  it('starts on modeEdge alone, in player mode, when the epoch has not been shown', () => {
    expect(
      tourStartDecision({
        epochChanged: false,
        modeEdge: true,
        mode: 'player',
        enabled: true,
        gateState: INITIAL_TOUR_GATE_STATE,
      }),
    ).toBe(true)
  })

  it('starts on epochChanged alone, in player mode, when the epoch has not been shown - the wiring-gap fix', () => {
    const bumped: TourGateState = { epoch: 2, xrActive: true, shownForEpoch: 1 }
    expect(
      tourStartDecision({
        epochChanged: true,
        modeEdge: false,
        mode: 'player',
        enabled: true,
        gateState: bumped,
      }),
    ).toBe(true)
  })

  it('still defers to shouldShowTour - an already-shown epoch does not restart, even with modeEdge or epochChanged true', () => {
    expect(
      tourStartDecision({ epochChanged: true, modeEdge: false, mode: 'player', enabled: true, gateState: shownState }),
    ).toBe(false)
    expect(
      tourStartDecision({ epochChanged: false, modeEdge: true, mode: 'player', enabled: true, gateState: shownState }),
    ).toBe(false)
  })

  it('is false whenever the tutorial is switched off, regardless of every other flag', () => {
    const bumped: TourGateState = { epoch: 2, xrActive: true, shownForEpoch: 1 }
    expect(
      tourStartDecision({ epochChanged: true, modeEdge: true, mode: 'player', enabled: false, gateState: bumped }),
    ).toBe(false)
  })
})

/**
 * The wiring-gap fix, traced end to end through the same three primitives
 * `App.tsx`'s two effects actually call: `advanceTourGateEpoch` (the
 * `xrStore` subscription), `tourStartDecision`+`markTourShown` (the shared
 * "start it" sequence both effects funnel through - see `tourGate.ts`'s own
 * doc comment on `tourStartDecision`), threaded through the `mode` value
 * would have at each point. These are the four scenarios the fix round
 * specifically asked to be covered.
 */
describe('the wiring-gap fix - four scenarios, traced through the real call shape', () => {
  /** Simulates the `xrStore.subscribe` effect: advances the epoch and reports whether THIS call changed it. */
  function fireXrModeChange(gate: TourGateState, xrMode: 'none' | 'immersive-vr' | 'immersive-ar') {
    const next = advanceTourGateEpoch(gate, xrMode)
    return { gate: next, epochChanged: next.epoch !== gate.epoch }
  }

  /** Simulates either effect's shared "start it" call - `App.tsx`'s `maybeStartTour`. */
  function maybeStart(
    gate: TourGateState,
    opts: { epochChanged: boolean; modeEdge: boolean; mode: 'browse' | 'player' },
  ) {
    const started = tourStartDecision({ ...opts, enabled: true, gateState: gate })
    return { gate: started ? markTourShown(gate) : gate, started }
  }

  it('scenario 1: headset re-entry with the SAME recording still open (mode never leaves player) - the bug', () => {
    // Visitor 1's session already showed the tour; their recording is still
    // open when visitor 1 takes the headset off (mode stays 'player' the
    // whole time - there is no browse->player edge anywhere in this trace).
    let gate: TourGateState = { epoch: 1, xrActive: true, shownForEpoch: 1 }
    const mode = 'player'

    // Visitor 1 removes the headset.
    let xr = fireXrModeChange(gate, 'none')
    gate = xr.gate
    let start = maybeStart(gate, { epochChanged: xr.epochChanged, modeEdge: false, mode })
    gate = start.gate
    expect(start.started).toBe(false) // ending a session never starts anything

    // Visitor 2 dons the headset - a FRESH session - while the previous
    // recording is still open. Before the fix, nothing ever re-consulted
    // `shouldShowTour` here.
    xr = fireXrModeChange(gate, 'immersive-vr')
    gate = xr.gate
    expect(xr.epochChanged).toBe(true)
    start = maybeStart(gate, { epochChanged: xr.epochChanged, modeEdge: false, mode })
    gate = start.gate

    expect(start.started).toBe(true) // the fix: visitor 2 gets the tour
    expect(gate.shownForEpoch).toBe(gate.epoch)
  })

  it('scenario 2: VR entered mid-visit, after the tour already ran once in the magic window', () => {
    let gate = INITIAL_TOUR_GATE_STATE
    let mode: 'browse' | 'player' = 'browse'

    // Magic-window visitor opens a recording and sees the tour.
    mode = 'player'
    let start = maybeStart(gate, { epochChanged: false, modeEdge: true, mode })
    gate = start.gate
    expect(start.started).toBe(true)

    // WITHOUT leaving player mode (same recording still open), the same
    // visitor puts a headset on - a fresh immersive session starting mid-visit.
    const xr = fireXrModeChange(gate, 'immersive-vr')
    gate = xr.gate
    expect(xr.epochChanged).toBe(true)
    start = maybeStart(gate, { epochChanged: xr.epochChanged, modeEdge: false, mode })
    gate = start.gate

    expect(start.started).toBe(true) // the fix: a fresh session re-shows it, even with no mode edge
  })

  it('scenario 3: VR entered from browse, THEN a recording is opened - fires exactly once, on the mode edge', () => {
    let gate = INITIAL_TOUR_GATE_STATE
    const modeWhileBrowsing: 'browse' | 'player' = 'browse'

    // Visitor enters VR from the library - no recording open yet.
    const xr = fireXrModeChange(gate, 'immersive-vr')
    gate = xr.gate
    expect(xr.epochChanged).toBe(true)
    let start = maybeStart(gate, { epochChanged: xr.epochChanged, modeEdge: false, mode: modeWhileBrowsing })
    gate = start.gate
    expect(start.started).toBe(false) // must NOT fire early while still browsing
    expect(gate.shownForEpoch).toBe(null) // and must not be marked shown either

    // The visitor now opens a recording - the browse->player edge.
    start = maybeStart(gate, { epochChanged: false, modeEdge: true, mode: 'player' })
    gate = start.gate
    expect(start.started).toBe(true) // fires here instead - exactly once
  })

  it('scenario 4: plain browse->player, no VR at all (the ordinary magic-window case, unchanged by the fix)', () => {
    let gate = INITIAL_TOUR_GATE_STATE

    let start = maybeStart(gate, { epochChanged: false, modeEdge: true, mode: 'player' })
    gate = start.gate
    expect(start.started).toBe(true)

    // A second recording opened later in the same page load, still no XR
    // session anywhere in this trace - no repeat.
    start = maybeStart(gate, { epochChanged: false, modeEdge: false, mode: 'player' })
    gate = start.gate
    expect(start.started).toBe(false)
  })
})
