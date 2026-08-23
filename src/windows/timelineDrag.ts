import { Matrix4, Plane, Ray, Vector3 } from 'three'
import { clampFraction } from './transportState'

/**
 * The timeline's pointer machinery, split into two pure, independently
 * tested layers - neither touches React, uikit, or the store:
 *
 * 1. `rayToTrackFraction` - where a world-space ray hits the track's plane,
 *    as a fraction along its width.
 * 2. `reduceDrag` - the drag gesture's state machine (pointerId gating,
 *    capture/release, cancel-vs-commit), independent of how a fraction was
 *    computed.
 *
 * `DockTransport.tsx` is thin glue over both.
 */

/**
 * Where a world-space ray hits the plane a track lies in, as a fraction of
 * its width in [0, 1].
 *
 * CRITICAL FIX (code review, round 1): the original implementation read
 * `e.point` - the intersection point r3f's raycaster captured at the moment
 * the pointer first hit the track's mesh. For a POINTER-CAPTURED drag (this
 * component calls `setPointerCapture` on pointerdown, exactly like
 * `useDragOnSphere.ts`), r3f's `capturedMap` keeps re-emitting that SAME
 * captured intersection on every subsequent move/up - it does not recompute
 * `point` once the pointer has left the original mesh's bounds. `e.ray`,
 * by contrast, IS recomputed every frame from the current pointer position
 * and camera, regardless of capture. So a drag that continues past either
 * edge of the (finite, 30px-tall) track mesh - the exact scenario the brief
 * names ("dragging the timeline scrubs ... releases into a real seek") -
 * left the preview stuck at the last position the pointer was still
 * physically over the mesh, instead of clamping to 0 or the full duration.
 * This is why `useDragOnSphere.ts`/`useResizeOnSphere.ts` never read
 * `e.point` either - they intersect `e.ray` against their own geometry
 * (a sphere) for exactly this reason.
 *
 * The track's local geometry is a unit plane at local z=0 (see
 * `DockTransport.tsx`'s own doc comment on why - `@pmndrs/uikit`'s
 * `createPanelGeometry()`). `trackMatrixWorld` carries that plane to world
 * space; intersecting `ray` against it and converting the hit back to local
 * space via the inverse matrix gives local x in the same [-0.5, 0.5] range
 * as before, `+0.5` shifts it to [0, 1], and `clampFraction` handles a hit
 * past either edge - the plane itself is infinite, so a ray from anywhere
 * on screen still hits it; it's the LOCAL X that can land outside the
 * track's own width, and clamping that is what makes "past the edge clamps
 * to 0/duration" (rather than getting stuck) actually true.
 *
 * Returns `null` only when the ray does not hit the plane at all - parallel
 * to it, or pointing away from it (the plane is one-sided from the ray's
 * perspective in three.js's own `Ray.intersectPlane`) - which in practice
 * means the pointer's screen ray is edge-on to the track's own surface, an
 * extreme case that should never come from a real drag continuing in the
 * same screen direction. Callers should treat `null` as "no new
 * information this event" and keep whatever fraction they already had,
 * exactly as they would for a track ref that hasn't mounted yet.
 */
export function rayToTrackFraction(
  origin: Vector3,
  direction: Vector3,
  trackMatrixWorld: Matrix4,
): number | null {
  const localPlane = new Plane(new Vector3(0, 0, 1), 0)
  const worldPlane = localPlane.applyMatrix4(trackMatrixWorld)
  const ray = new Ray(origin, direction)
  const hit = new Vector3()
  if (!ray.intersectPlane(worldPlane, hit)) return null
  const inverse = trackMatrixWorld.clone().invert()
  hit.applyMatrix4(inverse)
  return clampFraction(hit.x + 0.5)
}

/** The drag gesture's own state - which pointer (if any) is currently dragging, and the last fraction it reported. */
export interface DragState {
  dragging: boolean
  pointerId: number | null
  /** Last non-null fraction seen while dragging - the fallback a `pointerup` commits with when its own ray misses the plane. */
  lastFraction: number | null
}

export const initialDragState: DragState = { dragging: false, pointerId: null, lastFraction: null }

export type DragEvent =
  | { type: 'pointerdown'; pointerId: number; fraction: number | null }
  | { type: 'pointermove'; pointerId: number; fraction: number | null }
  | { type: 'pointerup'; pointerId: number; fraction: number | null }
  | { type: 'pointercancel'; pointerId: number }

export type DragEffect =
  /** Preview the given fraction (`store.setSeekPreview(fractionToSeconds(fraction, durationS))`). */
  | { type: 'preview'; fraction: number }
  /** `element.setPointerCapture(pointerId)`. */
  | { type: 'capture'; pointerId: number }
  /** `element.releasePointerCapture(pointerId)`. */
  | { type: 'release'; pointerId: number }
  /** A real seek to this fraction (`engine.seek(fractionToSeconds(fraction, durationS))`). */
  | { type: 'commit'; fraction: number }
  /** `store.setSeekPreview(null)`. */
  | { type: 'clearPreview' }

/**
 * The timeline drag's state machine, as a pure `(state, event) -> {state,
 * effects}` reducer - the same shape as the engine's own step functions
 * (code review I3), and testable without a DOM, a pointer, or React.
 *
 * Behaviour, one rule per case:
 * - `pointerdown` with no resolvable fraction (ray missed the plane, or the
 *   track ref hasn't mounted) starts nothing - there is no position to
 *   preview yet. A resolvable one starts tracking THIS pointer, captures
 *   it, and previews immediately.
 * - `pointermove`/`pointerup` from any pointer OTHER than the one currently
 *   tracked (or arriving while nothing is being dragged at all) are
 *   rejected outright - no state change, no effects. This is the
 *   foreign-pointer rejection: a second, unrelated pointer moving over the
 *   track while a different one is mid-drag must not interfere.
 * - `pointermove` for the tracked pointer previews the new fraction when
 *   one resolves, and does NOTHING when it doesn't (`fraction: null`) -
 *   the ray-miss case keeps the last preview exactly as it was, per
 *   `rayToTrackFraction`'s own contract.
 * - `pointerup` for the tracked pointer ALWAYS commits - even when its own
 *   ray missed the plane, falling back to `lastFraction` (the most recent
 *   fraction a `pointerdown`/`pointermove` in this same gesture actually
 *   resolved) rather than doing nothing. This is "up commits even outside
 *   the track": a release is a release, not a discardable event, and
 *   `rayToTrackFraction`'s own clamping already means a fraction it DOES
 *   resolve is never itself invalid, just possibly at the 0/1 edge.
 * - `pointercancel` for the tracked pointer clears the preview WITHOUT a
 *   commit - the brief's "on pointercancel just clear preview" - and drops
 *   tracking. A cancel for an unrelated pointer is a no-op.
 */
export function reduceDrag(state: DragState, event: DragEvent): { state: DragState; effects: DragEffect[] } {
  switch (event.type) {
    case 'pointerdown': {
      if (event.fraction === null) return { state, effects: [] }
      return {
        state: { dragging: true, pointerId: event.pointerId, lastFraction: event.fraction },
        effects: [
          { type: 'capture', pointerId: event.pointerId },
          { type: 'preview', fraction: event.fraction },
        ],
      }
    }
    case 'pointermove': {
      if (!state.dragging || event.pointerId !== state.pointerId) return { state, effects: [] }
      if (event.fraction === null) return { state, effects: [] }
      return {
        state: { ...state, lastFraction: event.fraction },
        effects: [{ type: 'preview', fraction: event.fraction }],
      }
    }
    case 'pointerup': {
      if (!state.dragging || event.pointerId !== state.pointerId) return { state, effects: [] }
      const committed = event.fraction ?? state.lastFraction
      const effects: DragEffect[] = [{ type: 'release', pointerId: event.pointerId }]
      if (committed !== null) effects.push({ type: 'commit', fraction: committed })
      effects.push({ type: 'clearPreview' })
      return { state: initialDragState, effects }
    }
    case 'pointercancel': {
      if (!state.dragging || event.pointerId !== state.pointerId) return { state, effects: [] }
      return { state: initialDragState, effects: [{ type: 'clearPreview' }] }
    }
    default:
      return { state, effects: [] }
  }
}
