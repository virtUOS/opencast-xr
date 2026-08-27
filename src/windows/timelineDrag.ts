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

/**
 * The curved-mode counterpart to `rayToTrackFraction` - corrects for the
 * dock's cylindrical bend (sphere-shell 0.3.1's `useDockBendFrame`; see the
 * README's "Curved windows (experimental)" section for the worked recipe this
 * implements, and `DockTransport.tsx`'s doc comment, formerly a KNOWN
 * LIMITATION, for the discrepancy this closes).
 *
 * ## Why this needs the DOCK's bend frame, not just the track's own
 *
 * `rayToTrackFraction` above intersects the ray against the track's FLAT
 * plane and reads the hit in the TRACK's own local frame - exact in flat
 * mode, because the track's `Object3D` transform (`trackMatrixWorld`) is
 * never touched by the bend (only the drawn geometry is, per-vertex, in a
 * patched material - see sphere-shell's "It works by patching uikit's
 * materials"). In curved mode that same flat-plane intersection is exactly
 * what uikit's own flat hit-test would report too: a position systematically
 * displaced OUTWARD from what the viewer is actually looking at
 * (`flatXForBentX`'s doc comment derives the displacement,
 * `R·(tan k − k)`, positive and growing with the offset). The correction has
 * to run in the DOCK's own coordinate frame - not the track's - because the
 * cylinder's axis is the dock's vertical axis (`useDockBendFrame`'s `group`),
 * and the bend distorts a point's distance from THAT axis, not from the
 * track's own centre.
 *
 * ## The steps, matching the README's recipe exactly
 *
 * 1. Flat-plane hit, in WORLD space - identical to `rayToTrackFraction`'s own
 *    first step (same plane, same ray-intersect call).
 * 2. That hit, and the track's own left/right edges (`local x = ∓0.5` in the
 *    track's frame, carried to world via `trackMatrixWorld`), all converted
 *    into the bend group's local frame via `worldToLocal` - the codebase's
 *    established idiom (`useDragOnSphere.ts`), in METRES.
 * 3. Metres -> uikit layout PIXELS via `pixelSize`, the unit `bendRadiusPx`
 *    is expressed in - mixing metres with the pixel radius is exactly the
 *    silent-6.4%-error trap `useDockBendFrame`'s doc comment warns about.
 * 4. The inverse bend, `x_true = R·atan(x_flat / R)`, applied ONLY to the hit
 *    - the track's edges are the track's own AUTHORED (unbent) layout
 *    position, which - because the bend preserves arc length - already IS
 *    its true position on the cylinder; only a flat-plane RAY INTERSECTION
 *    picks up the `tan` displacement `flatXForBentX` describes, so only the
 *    hit needs undoing.
 * 5. The corrected hit interpolated between the (uncorrected) edges gives the
 *    fraction, exactly as `rayToTrackFraction`'s own `hit.x + 0.5` does for
 *    the flat case - `clampFraction` handles a hit past either edge the same
 *    way.
 *
 * Falls back to `null` (never throws) when the flat-plane ray misses, when
 * the track has collapsed to zero width in the bend frame (not yet laid out
 * - the same "no new information this event" contract `rayToTrackFraction`
 * documents), or when `bendRadiusPx` is not a finite positive number (should
 * be unreachable whenever `useDockBendFrame().curved` is true, but a
 * division by a bad radius must not produce `NaN`/`Infinity` fractions).
 *
 * `dockTransport.tsx` only calls this when `useDockBendFrame().curved` is
 * true and its `group`/`bendRadiusPx`/`pixelSize` are non-null; the flat path
 * (`rayToTrackFraction`) stays untouched and byte-identical for every other
 * case, including the frame-null fallback.
 */
export function rayToTrackFractionCurved(
  origin: Vector3,
  direction: Vector3,
  trackMatrixWorld: Matrix4,
  bendGroupMatrixWorld: Matrix4,
  bendRadiusPx: number,
  pixelSize: number,
): number | null {
  if (!Number.isFinite(bendRadiusPx) || bendRadiusPx <= 0) return null
  if (!Number.isFinite(pixelSize) || pixelSize <= 0) return null

  const localPlane = new Plane(new Vector3(0, 0, 1), 0)
  const worldPlane = localPlane.applyMatrix4(trackMatrixWorld)
  const ray = new Ray(origin, direction)
  const hit = new Vector3()
  if (!ray.intersectPlane(worldPlane, hit)) return null

  const groupInverse = bendGroupMatrixWorld.clone().invert()
  const leftLocal = new Vector3(-0.5, 0, 0).applyMatrix4(trackMatrixWorld).applyMatrix4(groupInverse)
  const rightLocal = new Vector3(0.5, 0, 0).applyMatrix4(trackMatrixWorld).applyMatrix4(groupInverse)
  const hitLocal = hit.applyMatrix4(groupInverse)

  const leftPx = leftLocal.x / pixelSize
  const rightPx = rightLocal.x / pixelSize
  if (rightPx === leftPx) return null // track not laid out yet - zero width in the bend frame

  const hitFlatPx = hitLocal.x / pixelSize
  const hitTruePx = bendRadiusPx * Math.atan(hitFlatPx / bendRadiusPx)

  return clampFraction((hitTruePx - leftPx) / (rightPx - leftPx))
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
