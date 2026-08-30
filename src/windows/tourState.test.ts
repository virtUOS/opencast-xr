import { describe, expect, it } from 'vitest'
import { INITIAL_TOUR_STATE, isLastTourStep, reduceTour, type TourRuntimeState } from './tourState'

describe('reduceTour', () => {
  it('starts at step 0, active', () => {
    expect(reduceTour(INITIAL_TOUR_STATE, { type: 'start' }, 3)).toEqual({ active: true, stepIndex: 0 })
  })

  it('start always begins at the top, even if dispatched mid-tour', () => {
    const midTour: TourRuntimeState = { active: true, stepIndex: 2 }
    expect(reduceTour(midTour, { type: 'start' }, 3)).toEqual({ active: true, stepIndex: 0 })
  })

  it('advance walks forward one step at a time', () => {
    let state = reduceTour(INITIAL_TOUR_STATE, { type: 'start' }, 3)
    state = reduceTour(state, { type: 'advance' }, 3)
    expect(state).toEqual({ active: true, stepIndex: 1 })
    state = reduceTour(state, { type: 'advance' }, 3)
    expect(state).toEqual({ active: true, stepIndex: 2 })
  })

  it('advance on the last step finishes the tour (inactive, reset to 0)', () => {
    const lastStep: TourRuntimeState = { active: true, stepIndex: 2 }
    expect(reduceTour(lastStep, { type: 'advance' }, 3)).toEqual({ active: false, stepIndex: 0 })
  })

  it('advance while inactive is a no-op', () => {
    expect(reduceTour(INITIAL_TOUR_STATE, { type: 'advance' }, 3)).toBe(INITIAL_TOUR_STATE)
  })

  it('skip ends the tour from any step, including the first', () => {
    const firstStep: TourRuntimeState = { active: true, stepIndex: 0 }
    expect(reduceTour(firstStep, { type: 'skip' }, 3)).toEqual({ active: false, stepIndex: 0 })
    const midTour: TourRuntimeState = { active: true, stepIndex: 1 }
    expect(reduceTour(midTour, { type: 'skip' }, 3)).toEqual({ active: false, stepIndex: 0 })
    const lastStep: TourRuntimeState = { active: true, stepIndex: 2 }
    expect(reduceTour(lastStep, { type: 'skip' }, 3)).toEqual({ active: false, stepIndex: 0 })
  })

  it('skip while already inactive is a no-op', () => {
    expect(reduceTour(INITIAL_TOUR_STATE, { type: 'skip' }, 3)).toBe(INITIAL_TOUR_STATE)
  })

  it('a full walk through a 1-step tour finishes on the very first advance', () => {
    let state = reduceTour(INITIAL_TOUR_STATE, { type: 'start' }, 1)
    expect(state).toEqual({ active: true, stepIndex: 0 })
    state = reduceTour(state, { type: 'advance' }, 1)
    expect(state).toEqual({ active: false, stepIndex: 0 })
  })
})

describe('isLastTourStep', () => {
  it('is false while inactive, regardless of stepIndex', () => {
    expect(isLastTourStep({ active: false, stepIndex: 2 }, 3)).toBe(false)
  })

  it('is false on every step but the last', () => {
    expect(isLastTourStep({ active: true, stepIndex: 0 }, 3)).toBe(false)
    expect(isLastTourStep({ active: true, stepIndex: 1 }, 3)).toBe(false)
  })

  it('is true on the last step', () => {
    expect(isLastTourStep({ active: true, stepIndex: 2 }, 3)).toBe(true)
  })

  it('is true on the only step of a 1-step tour', () => {
    expect(isLastTourStep({ active: true, stepIndex: 0 }, 1)).toBe(true)
  })
})
