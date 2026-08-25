import type { OcSegment } from '../opencast/types'
import { activeSegmentIndex } from '../windows/chaptersState'

/**
 * The pure, unit-tested logic behind `windows/XRPlayerControls.tsx` - the
 * player's own VR controller bindings.
 *
 * ## Why this lives in the APP and not in sphere-shell
 *
 * The library owns locomotion (right thumbstick, and one configurable face
 * button for recentering - see `XRControlsProps.recenterButton`, added this
 * round precisely so the app could take A). It must not learn about playback:
 * a window manager that knows what „pause" means is no longer a window
 * manager. So everything here - seeking, chapters, play/pause - is the app's,
 * reading the same `@react-three/xr` store the library reads, from a component
 * mounted in the app's own `<XR>` tree.
 *
 * ## Why it is pure, and split out at all
 *
 * The same reason `timelineDrag.ts`, `chaptersState.ts` and sphere-shell's
 * `xrNavigation.ts` are: no XR session is reachable in this project's
 * automated environment, so a `useFrame` reading a real gamepad can never be
 * exercised. Everything that could be WRONG - a deadzone, a rate curve, a
 * latch, a chapter index - is therefore a plain function over plain numbers,
 * and the component is thin glue that only has to be read, not tested.
 *
 * ## The bindings, and where each requirement came from
 *
 * | Input | Action | User's words |
 * |---|---|---|
 * | Left stick, horizontal | scrub the position, faster the further it is pushed | „Links/rechts sind vor- und zurückspringen, das sollte auch schneller oder langsamer gehen, je stärker ich den Stick bewege" |
 * | Left stick, vertical flick | one chapter per deliberate flick | „Rauf und runter geht dann kapitelweise weiter. Das aber nur mit dedizierter Bewegung. Also einmal stark bewegen springt 1 Kapitel." |
 * | A (right) or X (left) | play/pause | „Taste A und X für Play/Pause." |
 * | B (right), held ~1 s | recenter | „Taste B dann zum Neuzentrieren." (the library's, via `recenterButton`) |
 */

/**
 * Left-stick deflection below which seeking is exactly zero.
 *
 * The same 0.2 sphere-shell uses for stick ROTATION, and for a closely related
 * reason: both are unbounded integrators. A resting thumb on a Quest Touch
 * stick reads a few hundredths off centre, and a seek rate that was merely
 * small there would walk the playhead away from where the viewer parked it for
 * as long as the app is open. (The dolly can afford 0.15 because it stops at
 * the shell wall; this cannot, and a video that slowly drifts out from under
 * you is a worse failure than a slow drift across a room.)
 */
export const SEEK_DEADZONE = 0.2

/**
 * Seconds of video per second of holding, just past the deadzone.
 *
 * Deliberately gentle: this is the rate for „nudge me back a few seconds, I
 * missed that sentence", which is the common case and the one that has to be
 * precise. At 2 s/s a half-second push moves one second - fine enough to land
 * on a word.
 */
export const SEEK_MIN_RATE = 2

/**
 * Seconds of video per second of holding, at full deflection.
 *
 * 30 s/s crosses a 10-minute recording in 20 s and a 90-minute lecture in
 * three minutes. That is deliberately NOT "fast enough to cross any recording":
 * long jumps have two better instruments already - the chapter flick (one
 * gesture, exact) and the dock timeline (one drag, absolute) - and a stick fast
 * enough to replace them would be too fast to be precise at the bottom of its
 * travel, which is where it is actually used.
 *
 * Flagged for the headset run: if 30 s/s feels sluggish in practice, this is
 * the one number to change (see `QUEST-VALIDATION-PLAYER.md`).
 */
export const SEEK_MAX_RATE = 30

/**
 * The exponent of the rate curve between those two.
 *
 * The rate is `MIN + (MAX - MIN) · t^EXPONENT`, where `t` is the deflection
 * rescaled from the deadzone edge to full travel. A linear ramp puts 16 s/s at
 * half stick, which is too coarse for the fine-adjustment case that dominates;
 * squaring puts about 9 s/s there and keeps the bottom third of the travel
 * under 5 s/s, while still reaching the full rate at the stop. The user asked
 * for „schneller oder langsamer, je stärker ich den Stick bewege" - a curve
 * satisfies that as fully as a line does, and is easier to aim.
 */
export const SEEK_RATE_EXPONENT = 2

/**
 * Longest frame delta the scrub will integrate over, in seconds.
 *
 * `useFrame`'s delta is wall-clock, so a GC pause, a shader compile or a
 * backgrounded tab hands the next frame several hundred milliseconds. At the
 * full rate an unclamped 500 ms frame moves the target 15 s in one step -
 * indistinguishable, from the viewer's side, from the gesture having gone
 * haywire. Same guard, same value, as sphere-shell's
 * `XR_ROTATION_MAX_FRAME_DELTA`.
 */
export const SEEK_MAX_FRAME_DELTA = 0.1

/** Deflection a vertical flick must REACH before it counts as one. */
export const FLICK_FIRE_THRESHOLD = 0.8

/**
 * Deflection the stick must return BELOW before another flick can fire.
 *
 * The gap between this and `FLICK_FIRE_THRESHOLD` is the hysteresis, and it is
 * what makes „nur mit dedizierter Bewegung" true. With a single threshold, a
 * thumb resting anywhere near it - or a stick that overshoots and settles -
 * pages through the chapter list at frame rate. 0.35 is low enough that
 * clearing it means the thumb genuinely came back, and high enough that it does
 * not demand a return to dead centre.
 */
export const FLICK_ARM_THRESHOLD = 0.35

export interface StickSeekOptions {
  deadzone?: number
  minRate?: number
  maxRate?: number
  exponent?: number
  maxFrameDelta?: number
}

/**
 * Seek rate for one horizontal stick reading, in **seconds of video per second
 * of holding**, signed like the stick (right = forward).
 *
 * Pure and stateless, exactly like `stickYawDegrees`: the rate is a function of
 * the CURRENT stick position only. There is no acceleration to accumulate, so
 * holding the stick still never speeds up and letting go stops instantly.
 *
 * Four properties, all pinned by tests:
 *
 * 1. **Deadzone.** `|x| <= deadzone` is exactly 0.
 * 2. **Rescaled from the deadzone edge.** `t = (|x| - deadzone) / (1 - deadzone)`,
 *    so the rate starts at `minRate` where the deadzone ends instead of jumping
 *    to whatever the curve happens to be at `deadzone`.
 * 3. **Curved.** `minRate + (maxRate - minRate) · t^exponent` - see
 *    `SEEK_RATE_EXPONENT`.
 * 4. **Capped.** `t` is clamped to 1, so a driver reporting `|x| > 1` cannot
 *    outrun `maxRate`.
 */
export function stickSeekRate(xAxis: number, options: StickSeekOptions = {}): number {
  const deadzone = options.deadzone ?? SEEK_DEADZONE
  const minRate = options.minRate ?? SEEK_MIN_RATE
  const maxRate = options.maxRate ?? SEEK_MAX_RATE
  const exponent = options.exponent ?? SEEK_RATE_EXPONENT
  const magnitude = Math.abs(xAxis)
  if (!(magnitude > deadzone)) return 0
  const t = Math.min(1, (magnitude - deadzone) / (1 - deadzone))
  return Math.sign(xAxis) * (minRate + (maxRate - minRate) * Math.pow(t, exponent))
}

/** The scrub gesture's whole state: the target being scrubbed to, or `null` between gestures. */
export interface StickSeekState {
  /**
   * Where the gesture will seek to when the stick is released, in seconds -
   * and `null` exactly when no gesture is in progress. One field, because
   * "is a gesture running" and "where has it got to" are the same question.
   */
  targetS: number | null
}

export const INITIAL_STICK_SEEK_STATE: StickSeekState = { targetS: null }

export interface StickSeekInput {
  /** `gamepad['xr-standard-thumbstick'].xAxis` of the LEFT controller. */
  xAxis: number
  /** Seconds since the previous frame (`useFrame`'s delta). */
  delta: number
  /** The store's live `currentTimeS` - where a FRESH gesture starts from. */
  currentTimeS: number
  /** The open recording's duration in seconds; the scrub is clamped to it. */
  durationS: number
}

export interface StickSeekResult {
  state: StickSeekState
  /** Feed to `store.setSeekPreview` — `null` means "clear it". */
  preview: number | null
  /** Non-null on exactly the frame the gesture ends: feed to `engine.seek`. */
  commit: number | null
}

/**
 * One frame of the horizontal scrub: **preview while held, seek on release**.
 *
 * ## Why it does not seek continuously
 *
 * Because seeking an `HTMLVideoElement` is expensive and asynchronous. Each
 * `currentTime` write tears down the decode pipeline, re-seeks to a keyframe
 * and re-buffers; issued once per frame it never completes one before starting
 * the next, so the picture freezes, `readyState` collapses, and (in this app
 * specifically) `SyncEngine.reconcileStall` reads that as a genuine stall and
 * pauses every stream - two or three of them, all thrashing at once. The
 * gesture would fight the very machinery that keeps the wall in sync.
 *
 * So the gesture scrubs a NUMBER. The number is fed to `setSeekPreview`, which
 * this app already renders in the head-locked HUD (with the chapter title at
 * that position - see `subtitleHudState.ts`'s `seekFeedback`) and in the dock's
 * own time readout and fill bar. Exactly one `engine.seek` happens, on release.
 *
 * This is not a new interaction model: it is the model the dock timeline drag
 * already uses (`timelineDrag.ts`: preview on move, commit on `pointerup`), so
 * the two ways of seeking in this app behave and LOOK identically, and the
 * feedback HUD needed no changes to serve both.
 *
 * ## Where a gesture starts
 *
 * From `currentTimeS` on its first frame, and from its own accumulated target
 * afterwards. It has to accumulate: nothing is committed mid-gesture, so the
 * playhead does not move, and a target recomputed from the playhead each frame
 * would never travel further than one frame's worth.
 *
 * @returns `preview` for `store.setSeekPreview` (a number while scrubbing,
 *   `null` on the frame the gesture ends), and `commit` for `engine.seek`
 *   (non-null on exactly that frame). Both are `null` while the stick rests.
 */
export function stepStickSeek(
  state: StickSeekState,
  input: StickSeekInput,
  options: StickSeekOptions = {},
): StickSeekResult {
  const rate = stickSeekRate(input.xAxis, options)

  if (rate === 0) {
    // Inside the deadzone. If a gesture was running, this frame ends it.
    if (state.targetS === null) return { state, preview: null, commit: null }
    return { state: INITIAL_STICK_SEEK_STATE, preview: null, commit: state.targetS }
  }

  const maxFrameDelta = options.maxFrameDelta ?? SEEK_MAX_FRAME_DELTA
  // `|| 0` also normalises a NaN delta (Number.isFinite would need a branch of
  // its own to say the same thing); the clamp handles a hitch and a negative.
  const step = Math.min(Math.max(input.delta || 0, 0), maxFrameDelta)
  const duration = Math.max(0, input.durationS || 0)
  const base = state.targetS ?? input.currentTimeS
  const next = Math.min(duration, Math.max(0, base + rate * step))
  return { state: { targetS: next }, preview: next, commit: null }
}

/** The vertical flick's state: whether a new flick is allowed to fire yet. */
export interface FlickState {
  /**
   * `true` when the stick has been back near centre since the last flick fired
   * - i.e. a fresh deliberate movement can be recognised. The latch is the
   * same idea as `stepLongPress`'s `firedThisPress`, with a RANGE instead of a
   * boolean input.
   */
  armed: boolean
}

/** Armed, so the very first flick after mounting counts. */
export const INITIAL_FLICK_STATE: FlickState = { armed: true }

export interface FlickOptions {
  fireThreshold?: number
  armThreshold?: number
}

/**
 * One frame of the vertical chapter flick: **one deliberate push, one
 * chapter**.
 *
 * „Das aber nur mit dedizierter Bewegung. Also einmal stark bewegen springt 1
 * Kapitel." Two mechanisms make that true, and both are needed:
 *
 * 1. **A high fire threshold** (`FLICK_FIRE_THRESHOLD`, 0.8). A vague push does
 *    nothing - the gesture has to be meant. It also keeps the vertical axis out
 *    of the way of the horizontal scrub, which is the axis actually being used:
 *    a diagonal push while seeking would otherwise jump a chapter.
 * 2. **Hysteresis** (`FLICK_ARM_THRESHOLD`, 0.35). Firing when a threshold is
 *    CROSSED is not enough on a physical stick, which sits at 0.83, 0.79, 0.81
 *    while a thumb holds it. The flick disarms on fire and only re-arms once
 *    the stick has genuinely come back, so a held stick is one chapter, not
 *    seventy-two per second.
 *
 * ## Direction
 *
 * WebXR reports the thumbstick's `yAxis` as **negative up** (the convention
 * sphere-shell's dolly relies on when it negates `yAxis` to move forward). Up
 * is mapped to the PREVIOUS chapter and down to the next, matching the order
 * the „Kapitel" window lists them in - earliest at the top - so the stick moves
 * the same way the eye does down that list.
 *
 * @returns `steps`: `-1` (previous chapter), `+1` (next), or `0` for nothing
 *   this frame. Feed a non-zero value to `chapterSeekTarget`.
 */
export function stepChapterFlick(
  state: FlickState,
  yAxis: number,
  options: FlickOptions = {},
): { state: FlickState; steps: -1 | 0 | 1 } {
  const fireThreshold = options.fireThreshold ?? FLICK_FIRE_THRESHOLD
  const armThreshold = options.armThreshold ?? FLICK_ARM_THRESHOLD
  const magnitude = Math.abs(yAxis)

  if (!state.armed) {
    // Only the return to (near) centre matters while disarmed.
    return { state: magnitude <= armThreshold ? { armed: true } : state, steps: 0 }
  }
  if (magnitude < fireThreshold) return { state, steps: 0 }
  return { state: { armed: false }, steps: yAxis < 0 ? -1 : 1 }
}

/**
 * Where a chapter flick should seek to, in seconds - or `null` when there is
 * nowhere to go.
 *
 * `null` covers three real cases, all of which must be silent no-ops rather
 * than a seek to 0: a recording with no segments at all (which is most of
 * `develop.opencast.org` - hence the „Kapitel (Test)" dev checkbox), a flick
 * forward from inside the last chapter, and a flick back from inside the first.
 *
 * ## Why "previous" is a plain index step
 *
 * A media player's previous-track button conventionally restarts the CURRENT
 * track first and only steps back if you press it again quickly. That
 * convention is deliberately not used here: „einmal stark bewegen springt 1
 * Kapitel" says one flick is one chapter, and an asymmetric back step would
 * mean down-then-up does not return you to where you started - which, with a
 * gesture this cheap to fire by accident, is exactly the property worth having.
 *
 * Built on `chaptersState.ts`'s `activeSegmentIndex` rather than a second
 * "which segment is active" implementation - that function already handles
 * unsorted input and the final segment's missing end bound.
 */
export function chapterSeekTarget(
  segments: OcSegment[],
  currentTimeS: number,
  direction: number,
): number | null {
  if (direction === 0 || segments.length === 0) return null
  const active = activeSegmentIndex(segments, currentTimeS)
  // `active < 0` means the playhead precedes every segment's start. Forward
  // from there is the first segment; back from there is nowhere.
  const next = active < 0 ? (direction > 0 ? 0 : -1) : active + Math.sign(direction)
  if (next < 0 || next >= segments.length) return null
  return segments[next].startMs / 1000
}

/** A single button's edge-detection state. */
export interface PressLatchState {
  wasPressed: boolean
}

export const INITIAL_PRESS_LATCH: PressLatchState = { wasPressed: false }

/**
 * Fires once per press, on the rising edge.
 *
 * A play/pause read straight off `state === 'pressed'` inside `useFrame`
 * toggles on every frame the button is held - 72 to 120 times a second, leaving
 * the video in whichever state the release happened to land on. This is the
 * minimum machinery that fixes it, and the same latch idea as sphere-shell's
 * `stepLongPress` with the timer removed.
 *
 * `XRPlayerControls` drives ONE latch from `A || X` rather than one per button,
 * so the two are genuinely the same control: pressing both at once toggles
 * once, and A-then-X while still holding A does nothing extra.
 */
export function stepPressLatch(
  state: PressLatchState,
  pressed: boolean,
): { state: PressLatchState; fire: boolean } {
  if (pressed === state.wasPressed) return { state, fire: false }
  return { state: { wasPressed: pressed }, fire: pressed }
}
