import { describe, expect, it } from 'vitest'
import {
  INITIAL_TOUR_GATE_STATE,
  advanceTourGateEpoch,
  markTourShown,
  shouldShowTour,
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
