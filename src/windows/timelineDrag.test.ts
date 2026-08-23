import { describe, expect, it } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  type DragState,
  initialDragState,
  rayToTrackFraction,
  reduceDrag,
} from './timelineDrag'

describe('rayToTrackFraction', () => {
  const identity = new Matrix4()

  it('a ray straight down the local z axis at local x=0 lands at fraction 0.5 (identity transform)', () => {
    const origin = new Vector3(0, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFraction(origin, direction, identity)).toBeCloseTo(0.5, 6)
  })

  it('clamps to 0 when the ray hits well past the track\'s left edge', () => {
    const origin = new Vector3(-5, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFraction(origin, direction, identity)).toBe(0)
  })

  it('clamps to 1 when the ray hits well past the track\'s right edge', () => {
    const origin = new Vector3(5, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFraction(origin, direction, identity)).toBe(1)
  })

  it('returns null when the ray is parallel to the track\'s plane (no intersection at all)', () => {
    const origin = new Vector3(0, 0, 5)
    const direction = new Vector3(1, 0, 0) // perpendicular to the plane's normal (0,0,1)
    expect(rayToTrackFraction(origin, direction, identity)).toBeNull()
  })

  it('returns null when the ray points away from the plane (intersection would be behind the origin)', () => {
    const origin = new Vector3(0, 0, 5)
    const direction = new Vector3(0, 0, 1) // pointing away from z=0
    expect(rayToTrackFraction(origin, direction, identity)).toBeNull()
  })

  it('accounts for a non-identity transform (translated + scaled track), not just identity', () => {
    // local x=0.25 should map through translate(10,0,0)*scale(4,1,1) to world x = 10 + 0.25*4 = 11
    const m = new Matrix4().compose(
      new Vector3(10, 0, 0),
      new Quaternion(),
      new Vector3(4, 1, 1),
    )
    const origin = new Vector3(11, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFraction(origin, direction, m)).toBeCloseTo(0.75, 6)
  })

  it('a mid-track hit on the non-identity transform still resolves to 0.5', () => {
    const m = new Matrix4().compose(
      new Vector3(10, 0, 0),
      new Quaternion(),
      new Vector3(4, 1, 1),
    )
    const origin = new Vector3(10, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFraction(origin, direction, m)).toBeCloseTo(0.5, 6)
  })
})

describe('reduceDrag', () => {
  it('pointerdown with a resolvable fraction starts dragging, captures the pointer, and previews', () => {
    const { state, effects } = reduceDrag(initialDragState, { type: 'pointerdown', pointerId: 1, fraction: 0.3 })
    expect(state).toEqual({ dragging: true, pointerId: 1, lastFraction: 0.3 })
    expect(effects).toEqual([
      { type: 'capture', pointerId: 1 },
      { type: 'preview', fraction: 0.3 },
    ])
  })

  it('pointerdown with no resolvable fraction (ray miss / track not mounted) starts nothing', () => {
    const { state, effects } = reduceDrag(initialDragState, { type: 'pointerdown', pointerId: 1, fraction: null })
    expect(state).toBe(initialDragState)
    expect(effects).toEqual([])
  })

  it('pointermove for the tracked pointer previews a new fraction', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointermove', pointerId: 1, fraction: 0.6 })
    expect(state).toEqual({ dragging: true, pointerId: 1, lastFraction: 0.6 })
    expect(effects).toEqual([{ type: 'preview', fraction: 0.6 }])
  })

  it('pointermove with a ray-miss (null fraction) keeps the last preview - no effects, state unchanged', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointermove', pointerId: 1, fraction: null })
    expect(state).toEqual(dragging)
    expect(effects).toEqual([])
  })

  it('pointermove from a FOREIGN pointer (not the one being tracked) is rejected outright', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointermove', pointerId: 2, fraction: 0.9 })
    expect(state).toBe(dragging)
    expect(effects).toEqual([])
  })

  it('pointermove while nothing is dragging is rejected outright', () => {
    const { state, effects } = reduceDrag(initialDragState, { type: 'pointermove', pointerId: 1, fraction: 0.5 })
    expect(state).toBe(initialDragState)
    expect(effects).toEqual([])
  })

  it('pointerup for the tracked pointer releases capture, commits its own fraction, and clears the preview', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointerup', pointerId: 1, fraction: 0.95 })
    expect(state).toEqual(initialDragState)
    expect(effects).toEqual([
      { type: 'release', pointerId: 1 },
      { type: 'commit', fraction: 0.95 },
      { type: 'clearPreview' },
    ])
  })

  it('pointerup commits even when the fraction resolved OUTSIDE the track (already clamped by rayToTrackFraction, e.g. exactly 1)', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.9 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointerup', pointerId: 1, fraction: 1 })
    expect(state).toEqual(initialDragState)
    expect(effects).toEqual([
      { type: 'release', pointerId: 1 },
      { type: 'commit', fraction: 1 },
      { type: 'clearPreview' },
    ])
  })

  it('pointerup whose OWN ray misses (fraction null) still commits, falling back to lastFraction', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.42 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointerup', pointerId: 1, fraction: null })
    expect(state).toEqual(initialDragState)
    expect(effects).toEqual([
      { type: 'release', pointerId: 1 },
      { type: 'commit', fraction: 0.42 },
      { type: 'clearPreview' },
    ])
  })

  it('pointerup from a FOREIGN pointer is rejected outright - no release, no commit', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointerup', pointerId: 2, fraction: 0.7 })
    expect(state).toBe(dragging)
    expect(effects).toEqual([])
  })

  it('pointerup while nothing is dragging is rejected outright', () => {
    const { state, effects } = reduceDrag(initialDragState, { type: 'pointerup', pointerId: 1, fraction: 0.5 })
    expect(state).toBe(initialDragState)
    expect(effects).toEqual([])
  })

  it('pointercancel for the tracked pointer clears the preview WITHOUT committing a seek', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointercancel', pointerId: 1 })
    expect(state).toEqual(initialDragState)
    expect(effects).toEqual([{ type: 'clearPreview' }])
  })

  it('pointercancel from a FOREIGN pointer is rejected outright', () => {
    const dragging: DragState = { dragging: true, pointerId: 1, lastFraction: 0.3 }
    const { state, effects } = reduceDrag(dragging, { type: 'pointercancel', pointerId: 2 })
    expect(state).toBe(dragging)
    expect(effects).toEqual([])
  })

  it('pointercancel while nothing is dragging is rejected outright', () => {
    const { state, effects } = reduceDrag(initialDragState, { type: 'pointercancel', pointerId: 1 })
    expect(state).toBe(initialDragState)
    expect(effects).toEqual([])
  })
})
