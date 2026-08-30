/**
 * A discrete button's press/release, as a pure `(state, event) -> {state,
 * effects}` reducer - the same shape as `timelineDrag.ts`'s `reduceDrag`, and
 * testable without a DOM, a pointer, or React.
 *
 * ## Why a discrete button needs ANY state machine at all
 *
 * Every button in this app (`DockTransport.tsx`'s `IconButton`,
 * `TourBubble.tsx`'s `TourButton`, `LibraryWindow.tsx`'s `BackButton`/retry
 * rows, `MediaList.tsx`'s tile rows) used to rely on uikit's own `onClick`,
 * which `@pmndrs/pointer-events` only synthesises when a `pointerdown` and
 * the following `pointerup` resolve to the EXACT SAME `Object3D` - see
 * `docs/UIKIT-NOTES.md` entry 6b. A Quest controller ray has natural hand
 * tremor („Mit den Zeigern der Quest zittere ich immer ein wenig, dann kann
 * aus einem Button Drücken ein verschieben werden"): a press that drifts off
 * the button before release lands the `pointerup` on a DIFFERENT object (the
 * panel behind it, a neighbouring control, or nothing at all), and the
 * press is silently discarded - the button never highlighted a "miss", it
 * just didn't fire.
 *
 * `timelineDrag.ts`'s own scrubber already solved exactly this for a DRAG
 * gesture: capture the pointer on `pointerdown` (`setPointerCapture`), so
 * every later event for that pointer routes back to the SAME object
 * regardless of where the ray points, and reads `e.ray` (recomputed every
 * frame) rather than `e.point` (frozen once captured - see that file's own
 * doc comment). A discrete button needs the SAME capture, but none of the
 * rest of that state machine - there is no drag to preview, no fraction to
 * compute, no track to scrub. This module is that narrower state machine:
 * capture on down, fire on up, nothing in between.
 *
 * ## Why capture alone is enough (verified against the installed library)
 *
 * `@pmndrs/pointer-events@6.6.30`'s `Pointer` (`dist/pointer.js`) resolves
 * `this.intersection` against the CAPTURED object for every subsequent event
 * once `pointerCapture` is set (`intersectPointerCapture`), rather than
 * re-raycasting against whatever is actually under the ray. `getIsClicked`
 * (the function behind `onClick`) reads `this.intersection.object` at
 * release time - so once a pointer is captured, that object is always the
 * one it captured on `pointerdown`, and the up-time/down-time press
 * timestamps it compares can never disagree. This module doesn't rely on
 * `onClick`/`getIsClicked` at all, though: it fires the action directly from
 * its own `pointerup` handling, deliberately bypassing BOTH of
 * `getIsClicked`'s failure modes at once - the drift this module exists to
 * fix, and the unrelated 300ms/1500ms press-duration budget entry 6a
 * documents (a deliberate, careful VR press is not a fast one).
 *
 * ## No movement-based cancel
 *
 * The brief allows an optional cancel when the ray has wandered far enough
 * off the button to no longer plausibly mean it - but only if that distance
 * is CHEAPLY measurable. It isn't, here: measuring "how far has the ray
 * moved" from inside a captured pointer event hits the exact same trap
 * `timelineDrag.ts`'s own doc comment (entry 4a) already found for
 * `e.point` - a captured event's intersection is pinned to the object it
 * captured on, so there is no cheap, already-available "current ray
 * position in the button's own local space" to compare against without
 * redoing a real ray/plane intersection per button (worthwhile for the ONE
 * timeline track; not for fifteen-plus small buttons). So this reducer never
 * cancels on distance: **release-anywhere-while-captured fires**, exactly
 * like a physical button (or Quest's own system UI) - a press only comes to
 * nothing via an explicit `pointercancel` (the pointer itself going away -
 * losing tracking, the session ending mid-press), never via drift.
 *
 * ## `disabled`, checked at BOTH ends
 *
 * A disabled button must stay inert on `pointerdown` (it never captures -
 * so a stray `pointerup` later, over whatever else is now under the ray, has
 * nothing to do) AND on `pointerup` (defensive: a button that has GONE
 * `disabled` mid-press - e.g. volume hit its ceiling while a caption's own
 * volume-up was somehow still held - releases its capture without firing,
 * rather than acting on stale intent). Both checks read whatever `disabled`
 * value the caller passes at THAT event, matching the old `onClick`'s own
 * "check `disabled` at release time" behaviour exactly, plus the new
 * down-time check the old code never needed (there was no separate down
 * handler to guard).
 */

/** Which pointer (if any) is currently pressing this button. */
export interface PressState {
  pressing: boolean
  pointerId: number | null
}

export const initialPressState: PressState = { pressing: false, pointerId: null }

export type PressEvent =
  | { type: 'pointerdown'; pointerId: number; disabled: boolean }
  | { type: 'pointerup'; pointerId: number; disabled: boolean }
  | { type: 'pointercancel'; pointerId: number }

export type PressEffect =
  /** `element.setPointerCapture(pointerId)`. */
  | { type: 'capture'; pointerId: number }
  /** `element.releasePointerCapture(pointerId)`. */
  | { type: 'release'; pointerId: number }
  /** Call the button's own `onPress()`. */
  | { type: 'fire' }

/**
 * The button press's own state machine - see this file's doc comment for the
 * behaviour each case encodes.
 *
 * - `pointerdown` while `disabled` starts nothing (no capture) - matches the
 *   old `onClick`'s "disabled buttons are inert" for the down half of a
 *   press. Otherwise it ALWAYS (re)arms tracking for the new pointer -
 *   deliberately unconditional, the same "most recent press wins" rule
 *   `reduceDrag`'s own `pointerdown` case uses, rather than rejecting a
 *   second concurrent press outright.
 * - `pointerup`/`pointercancel` from any pointer OTHER than the one
 *   currently tracked (or arriving while nothing is pressed at all) are
 *   rejected outright - no state change, no effects - the same
 *   foreign-pointer rejection `reduceDrag` uses.
 * - `pointerup` for the tracked pointer ALWAYS releases capture, and fires
 *   the action UNLESS the button is `disabled` right now (see the doc
 *   comment's "checked at both ends").
 * - `pointercancel` for the tracked pointer releases capture WITHOUT firing
 *   - a cancel means the gesture itself went away, not that it completed.
 */
export function reducePress(state: PressState, event: PressEvent): { state: PressState; effects: PressEffect[] } {
  switch (event.type) {
    case 'pointerdown': {
      if (event.disabled) return { state, effects: [] }
      return {
        state: { pressing: true, pointerId: event.pointerId },
        effects: [{ type: 'capture', pointerId: event.pointerId }],
      }
    }
    case 'pointerup': {
      if (!state.pressing || event.pointerId !== state.pointerId) return { state, effects: [] }
      const effects: PressEffect[] = [{ type: 'release', pointerId: event.pointerId }]
      if (!event.disabled) effects.push({ type: 'fire' })
      return { state: initialPressState, effects }
    }
    case 'pointercancel': {
      if (!state.pressing || event.pointerId !== state.pointerId) return { state, effects: [] }
      return { state: initialPressState, effects: [{ type: 'release', pointerId: event.pointerId }] }
    }
    default:
      return { state, effects: [] }
  }
}
