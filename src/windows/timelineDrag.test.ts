import { describe, expect, it } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { bendPoint } from 'sphere-shell'
import {
  type DragState,
  initialDragState,
  rayToTrackFraction,
  rayToTrackFractionCurved,
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

describe('rayToTrackFractionCurved', () => {
  /**
   * Builds a "true ray from the anchor" hitting a known fraction of a known
   * track, under a known bend - and returns the (origin, direction) that ray
   * resolves to, PLUS every input `rayToTrackFractionCurved` needs to try to
   * recover `fraction` from it.
   *
   * This is the independent-derivation half of the round-trip: it goes
   * through sphere-shell's own exported `bendPoint` (the library's FORWARD
   * map, local flat point -> point on the drawn cylinder) and a plain
   * ray/plane intersection, NOT through `flatXForBentX` or the `Math.atan`
   * inverse `rayToTrackFractionCurved` itself uses - so a bug that cancelled
   * itself between "how the test constructs the input" and "how the
   * production code undoes it" cannot hide here the way it could in an
   * implementation-vs-itself test.
   *
   * The "ray from the anchor" is the README's own reference case for
   * `flatXForBentX`'s derivation (a controller ray close enough to the
   * anchor origin): the anchor sits on-axis with the panel's own centre, at
   * local `(0, 0, R)` in the bend group's frame - `R` being the panel's own
   * placement radius, `bendRadiusM` (`bendRadiusPx * pixelSize`) in
   * `useDockBendFrame`'s own units.
   */
  function buildKnownBentHit({
    fraction,
    trackMatrixWorld,
    bendGroupMatrixWorld,
    bendRadiusPx,
    pixelSize,
  }: {
    fraction: number
    trackMatrixWorld: Matrix4
    bendGroupMatrixWorld: Matrix4
    bendRadiusPx: number
    pixelSize: number
  }): { origin: Vector3; direction: Vector3 } {
    const groupInverse = bendGroupMatrixWorld.clone().invert()
    const leftPx = new Vector3(-0.5, 0, 0)
      .applyMatrix4(trackMatrixWorld)
      .applyMatrix4(groupInverse).x / pixelSize
    const rightPx = new Vector3(0.5, 0, 0)
      .applyMatrix4(trackMatrixWorld)
      .applyMatrix4(groupInverse).x / pixelSize
    // The TRUE (unbent, authored) offset of `fraction` along the track, in
    // the bend group's own pixel space - this is the value bending preserves
    // as arc length, i.e. exactly the `p.x` `bendPoint` expects.
    const trueXPx = leftPx + fraction * (rightPx - leftPx)

    // The actual 3D point on the drawn (bent) surface, in the bend group's
    // LOCAL frame, still in pixel units (bendPoint's own unit is whatever the
    // radius's unit is - see its doc comment).
    const bentLocalPx = bendPoint({ x: trueXPx, y: 0, z: 0 }, bendRadiusPx)
    // -> metres, and into the bend group's local frame's own scale.
    const bentLocal = new Vector3(bentLocalPx.x, bentLocalPx.y, bentLocalPx.z).multiplyScalar(pixelSize)

    // The anchor, in the bend group's local frame: on-axis, at local z = R
    // (metres) - see the doc comment above.
    const bendRadiusM = bendRadiusPx * pixelSize
    const anchorLocal = new Vector3(0, 0, bendRadiusM)

    // Both carried to WORLD via the bend group's own transform - the ray this
    // returns is a genuine world-space ray, exactly what `e.ray` would be.
    const originWorld = anchorLocal.clone().applyMatrix4(bendGroupMatrixWorld)
    const bentWorld = bentLocal.clone().applyMatrix4(bendGroupMatrixWorld)
    return { origin: originWorld, direction: bentWorld.clone().sub(originWorld) }
  }

  it('recovers a known fraction end-to-end through bendPoint and a real ray/plane intersection (identity bend group)', () => {
    const trackMatrixWorld = new Matrix4().compose(
      new Vector3(10, 0, 0),
      new Quaternion(),
      new Vector3(4, 1, 1),
    )
    const bendGroupMatrixWorld = new Matrix4()
    const bendRadiusPx = 20
    const pixelSize = 1

    const { origin, direction } = buildKnownBentHit({
      fraction: 0.75,
      trackMatrixWorld,
      bendGroupMatrixWorld,
      bendRadiusPx,
      pixelSize,
    })

    expect(
      rayToTrackFractionCurved(origin, direction, trackMatrixWorld, bendGroupMatrixWorld, bendRadiusPx, pixelSize),
    ).toBeCloseTo(0.75, 6)
  })

  it('recovers a known fraction with a non-identity, non-trivial bend group transform and pixelSize != 1', () => {
    // The bend group sits off to the side and is scaled (metres per world
    // unit != 1), and pixelSize is not 1 either - exercising every
    // metres<->pixels and world<->local conversion the recipe needs, not just
    // the ones that happen to be identities.
    const bendGroupMatrixWorld = new Matrix4().compose(
      new Vector3(3, 1.5, -2),
      new Quaternion(),
      new Vector3(1, 1, 1),
    )
    // The track sits inside the bend group's tree, offset from its centre -
    // expressed here directly in WORLD space (as a real nested uikit tree
    // would resolve to), translated further out and scaled for its own width.
    const trackMatrixWorld = new Matrix4()
      .compose(new Vector3(0.6, 0, 0), new Quaternion(), new Vector3(0.8, 0.2, 1))
      .premultiply(bendGroupMatrixWorld)
    const bendRadiusPx = 900
    const pixelSize = 0.002

    const { origin, direction } = buildKnownBentHit({
      fraction: 0.2,
      trackMatrixWorld,
      bendGroupMatrixWorld,
      bendRadiusPx,
      pixelSize,
    })

    expect(
      rayToTrackFractionCurved(origin, direction, trackMatrixWorld, bendGroupMatrixWorld, bendRadiusPx, pixelSize),
    ).toBeCloseTo(0.2, 5)
  })

  it('recovers a fraction near the track edge (0.98) - the regime the KNOWN LIMITATION named as worst-case', () => {
    const trackMatrixWorld = new Matrix4().compose(
      new Vector3(10, 0, 0),
      new Quaternion(),
      new Vector3(4, 1, 1),
    )
    const bendGroupMatrixWorld = new Matrix4()
    const bendRadiusPx = 20
    const pixelSize = 1

    const { origin, direction } = buildKnownBentHit({
      fraction: 0.98,
      trackMatrixWorld,
      bendGroupMatrixWorld,
      bendRadiusPx,
      pixelSize,
    })

    expect(
      rayToTrackFractionCurved(origin, direction, trackMatrixWorld, bendGroupMatrixWorld, bendRadiusPx, pixelSize),
    ).toBeCloseTo(0.98, 5)
  })

  it('returns null when the ray misses the track plane entirely, same as the flat path', () => {
    const identity = new Matrix4()
    const origin = new Vector3(0, 0, 5)
    const direction = new Vector3(1, 0, 0) // parallel to the plane
    expect(rayToTrackFractionCurved(origin, direction, identity, identity, 20, 1)).toBeNull()
  })

  it('returns null for a non-finite or non-positive bend radius rather than dividing into NaN/Infinity', () => {
    const identity = new Matrix4()
    const origin = new Vector3(0, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFractionCurved(origin, direction, identity, identity, 0, 1)).toBeNull()
    expect(rayToTrackFractionCurved(origin, direction, identity, identity, -5, 1)).toBeNull()
    expect(rayToTrackFractionCurved(origin, direction, identity, identity, NaN, 1)).toBeNull()
  })

  it('returns null for a non-finite or non-positive pixelSize', () => {
    const identity = new Matrix4()
    const origin = new Vector3(0, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFractionCurved(origin, direction, identity, identity, 20, 0)).toBeNull()
    expect(rayToTrackFractionCurved(origin, direction, identity, identity, 20, -1)).toBeNull()
  })

  it('returns null for a track collapsed to zero width in the bend frame (not laid out yet)', () => {
    const identity = new Matrix4()
    // A track scaled to zero width: left and right edges land on the same point.
    const zeroWidthTrack = new Matrix4().compose(new Vector3(10, 0, 0), new Quaternion(), new Vector3(0, 1, 1))
    const origin = new Vector3(10, 0, 5)
    const direction = new Vector3(0, 0, -1)
    expect(rayToTrackFractionCurved(origin, direction, zeroWidthTrack, identity, 20, 1)).toBeNull()
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
