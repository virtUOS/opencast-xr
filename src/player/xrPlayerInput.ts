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

/**
 * How coarsely the scrub's PREVIEW is reported, in seconds.
 *
 * The exact target is kept in the state and is what a release commits; only
 * the number handed to `setSeekPreview` is rounded to this grid. At 72-120 Hz
 * an unrounded preview writes a new value every frame, which re-renders every
 * subscriber of `seekPreviewS` (the dock's readout and fill bar, the HUD) at
 * frame rate; on this grid it changes about four times a second instead - a
 * ~30x cut - and callers can skip the store write entirely when the value has
 * not moved.
 *
 * Invisible at the precision anything actually displays: the HUD and the dock
 * both format through `formatTimestamp`, which renders whole seconds, so a
 * quarter-second grid can never show a different string than the exact value
 * would - and the commit is exact regardless.
 */
export const SEEK_PREVIEW_STEP = 0.25

/** The scrub gesture's whole state. */
export interface StickSeekState {
  /**
   * Where the gesture will seek to when the stick is released, in seconds -
   * and `null` exactly when no gesture is in progress. One field, because
   * "is a gesture running" and "where has it got to" are the same question.
   *
   * Kept EXACT: `SEEK_PREVIEW_STEP` rounds what is displayed, never this.
   */
  targetS: number | null
  /**
   * Set when a chapter flick has just fired: no new scrub gesture may start
   * until the stick has come back to centre.
   *
   * This is the horizontal mirror of the flick's own re-arm hysteresis, and it
   * fixes a bug in which a chapter jump silently undid itself. A flick is a
   * push to |y| >= 0.8 followed by the thumb returning to centre - and that
   * RETURN PATH sweeps through positions with |x| well past the seek deadzone.
   * Without this latch the return started a fresh scrub gesture, which based
   * itself on the playhead and committed a seek on release - landing the
   * viewer back at, or near, the chapter they had just left. One gesture has
   * to have one outcome, so the flick claims the whole stick until it is
   * released.
   */
  suppressed: boolean
}

export const INITIAL_STICK_SEEK_STATE: StickSeekState = { targetS: null, suppressed: false }

/**
 * Abandons any scrub in flight and blocks the next one until the stick returns
 * to centre - what a chapter flick does to the horizontal axis. See
 * `StickSeekState.suppressed` for the bug this exists for.
 */
export function suppressStickSeek(): StickSeekState {
  return { targetS: null, suppressed: true }
}

export interface StickSeekInput {
  /** `gamepad['xr-standard-thumbstick'].xAxis` of the LEFT controller. */
  xAxis: number
  /** Seconds since the previous frame (`useFrame`'s delta). */
  delta: number
  /**
   * Where a FRESH gesture starts from, in seconds.
   *
   * Must be `engine.currentTime`, **not** the store's `currentTimeS`. The
   * store mirrors the engine on a 250 ms interval (`tickOnce`), so for up to a
   * quarter of a second after any seek it still reports the OLD position -
   * during which a fresh gesture based on it would scrub away from somewhere
   * the viewer has already left, and commit a seek back towards it.
   * `engine.currentTime` reads the master element, which `SyncEngine.seek`
   * writes synchronously, so it is correct on the very next frame.
   */
  currentTimeS: number
  /**
   * The open recording's duration in seconds; the scrub is clamped to it.
   *
   * A non-finite or non-positive value makes the whole gesture inert - see
   * `stepStickSeek`. `Episode.durationMs` is `Number(mp?.duration)` at the
   * parse boundary, so `NaN` is reachable from a real server response.
   */
  durationS: number
}

export interface StickSeekResult {
  state: StickSeekState
  /**
   * Feed to `store.setSeekPreview` — `null` means "nothing to show".
   *
   * Rounded to `SEEK_PREVIEW_STEP`; the exact target lives in `state.targetS`
   * and is what `commit` carries.
   */
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
  // No usable duration: the gesture cannot mean anything, so it is inert -
  // INCLUDING on the release path. This is not defensive padding.
  // `Episode.durationMs` comes from `Number(mp?.duration)`, so a recording
  // whose metadata lacks (or malforms) a duration yields `NaN`; clamping that
  // to a 0-length recording would make EVERY release commit `seek(0)` and
  // throw the viewer back to the start of the lecture. Returning the initial
  // state also drops any target accumulated before the duration went bad.
  if (!Number.isFinite(input.durationS) || input.durationS <= 0) {
    return { state: INITIAL_STICK_SEEK_STATE, preview: null, commit: null }
  }

  const rate = stickSeekRate(input.xAxis, options)

  // Locked out by a chapter flick: the thumb's return path must not start a
  // gesture. Only a genuine return to centre (rate 0, i.e. inside the
  // deadzone) clears it, and it never commits - `suppressStickSeek` already
  // dropped the target. See `StickSeekState.suppressed`.
  if (state.suppressed) {
    if (rate === 0) return { state: INITIAL_STICK_SEEK_STATE, preview: null, commit: null }
    return { state, preview: null, commit: null }
  }

  if (rate === 0) {
    // Inside the deadzone. If a gesture was running, this frame ends it.
    if (state.targetS === null) return { state, preview: null, commit: null }
    // The EXACT target, not the rounded preview - see SEEK_PREVIEW_STEP.
    return { state: INITIAL_STICK_SEEK_STATE, preview: null, commit: state.targetS }
  }

  const maxFrameDelta = options.maxFrameDelta ?? SEEK_MAX_FRAME_DELTA
  // `|| 0` also normalises a NaN delta (Number.isFinite would need a branch of
  // its own to say the same thing); the clamp handles a hitch and a negative.
  const step = Math.min(Math.max(input.delta || 0, 0), maxFrameDelta)
  const base = state.targetS ?? input.currentTimeS
  // `targetS` is finite by construction, so this only ever guards a bad
  // `currentTimeS`. Inert rather than clamped, for the same reason a bad
  // duration is: a NaN base silently clamped to 0 would commit `seek(0)`.
  if (!Number.isFinite(base)) {
    return { state: INITIAL_STICK_SEEK_STATE, preview: null, commit: null }
  }
  const next = Math.min(input.durationS, Math.max(0, base + rate * step))
  return {
    state: { targetS: next, suppressed: false },
    preview: Math.round(next / SEEK_PREVIEW_STEP) * SEEK_PREVIEW_STEP,
    commit: null,
  }
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

/**
 * DISARMED, so the stick must be seen near centre once before anything can
 * fire — the same discipline `INITIAL_PRESS_LATCH` follows for buttons.
 *
 * Starting armed looks friendlier and is wrong. This state is created (and
 * re-created, on every session end) with no knowledge of where the stick
 * physically is: a thumb already resting on a deflected stick as the session
 * opens would fire a chapter jump on the very first frame, before the viewer
 * had touched anything deliberately. Arming costs one frame at a centred
 * stick, which is the overwhelmingly common case and imperceptible.
 */
export const INITIAL_FLICK_STATE: FlickState = { armed: false }

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
 * ## Why it sorts first
 *
 * `chaptersState.ts`'s `activeSegmentIndex` is robust to unsorted input - it
 * picks the largest qualifying `startMs` rather than assuming ascending order -
 * and this function is built on it rather than re-deriving "which segment is
 * active" a second time. But "the NEXT chapter" is a step of one in TIME order,
 * and taking `active + 1` in ARRAY order silently assumes the two coincide.
 * Sorting a copy by `startMs` first is what actually makes the neighbour step
 * mean what its name says; the cost is one small copy per flick, and a flick
 * happens a few times a second at most.
 */
export function chapterSeekTarget(
  segments: OcSegment[],
  currentTimeS: number,
  direction: number,
): number | null {
  if (direction === 0 || segments.length === 0) return null
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs)
  const active = activeSegmentIndex(ordered, currentTimeS)
  // `active < 0` means the playhead precedes every segment's start. Forward
  // from there is the first segment; back from there is nowhere.
  const next = active < 0 ? (direction > 0 ? 0 : -1) : active + Math.sign(direction)
  if (next < 0 || next >= ordered.length) return null
  return ordered[next].startMs / 1000
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

/** Every piece of per-frame state the player's controller bindings carry. */
export interface XRPlayerInputState {
  seek: StickSeekState
  flick: FlickState
  playPause: PressLatchState
}

export const INITIAL_XR_PLAYER_INPUT_STATE: XRPlayerInputState = {
  seek: INITIAL_STICK_SEEK_STATE,
  flick: INITIAL_FLICK_STATE,
  playPause: INITIAL_PRESS_LATCH,
}

export interface XRPlayerFrameInput {
  /** Is an XR session running? Everything resets when it is not. */
  hasSession: boolean
  /** Is a recording open? False in browse mode, and before the first open. */
  hasEpisode: boolean
  /** LEFT thumbstick, `gamepad['xr-standard-thumbstick']`. */
  xAxis: number
  yAxis: number
  /** A (right controller) OR X (left) — one control, see `stepPressLatch`. */
  primaryPressed: boolean
  /** `useFrame`'s delta, in seconds. */
  delta: number
  /**
   * `engine.currentTime` — NOT the store's `currentTimeS`. See
   * `StickSeekInput.currentTimeS` for why the distinction is load-bearing.
   */
  currentTimeS: number
  /** `episode.durationMs / 1000`; may be `NaN` (see `StickSeekInput`). */
  durationS: number
  segments: OcSegment[]
  /** The store's current `seekPreviewS`, so a redundant write can be skipped. */
  previewS: number | null
}

export type XRPlayerEffect =
  /** `store.setPlaying(!store.playing)`. */
  | { type: 'togglePlay' }
  /** `store.setSeekPreview(seconds)`. */
  | { type: 'preview'; seconds: number }
  /** `store.setSeekPreview(null)`. */
  | { type: 'clearPreview' }
  /** `store.engine.seek(seconds)`. */
  | { type: 'seek'; seconds: number }

const NO_SEGMENTS: OcSegment[] = []

/**
 * One frame of the player's controller bindings, as a pure
 * `(state, input) -> { state, effects }` reducer — the same shape as
 * `timelineDrag.ts`'s `reduceDrag`, and for the same reason: it puts the whole
 * decision, including the interaction BETWEEN the three bindings, somewhere a
 * test can reach. `XRPlayerControls.tsx` reads a gamepad, calls this, and
 * executes the effects; it contains no decisions of its own.
 *
 * That last part is what makes this worth a reducer rather than three separate
 * calls in the component. The bugs this shape exists to prevent are all
 * cross-binding and all invisible when each machine is tested alone:
 *
 * - **A chapter jump undoing itself.** The flick seeks, then the thumb's return
 *   path sweeps the horizontal axis past the deadzone, starting a scrub that
 *   commits a seek straight back. Fixed by `suppressStickSeek` — the flick
 *   claims the whole stick until it is released, not just the vertical axis.
 * - **A stale clock reversing a seek.** Everything time-based reads
 *   `input.currentTimeS`, which callers must source from `engine.currentTime`.
 *   The store's mirror lags by up to 250 ms, which is easily long enough for a
 *   second gesture to start from a position the first one already left.
 * - **A no-op flick destroying a scrub.** The abandon happens only when a
 *   chapter is actually found — see below.
 *
 * ## Order within a frame
 *
 * 1. **No session** — reset everything; clear a preview ONLY if THIS
 *    component's own scrub gesture was the one showing it (see below), so
 *    taking the headset off mid-scrub cannot strand the HUD.
 * 2. **Play/pause**, before the episode gate: it is the one binding that is
 *    meaningful with no recording open, and `setPlaying` is a documented no-op
 *    on an empty engine.
 * 3. **Chapter flick**, before the scrub, so a diagonal push that clears the
 *    flick threshold resolves as ONE outcome.
 * 4. **Horizontal scrub** otherwise.
 *
 * ## The no-session clear must be ownership-gated, not `previewS !== null`
 *
 * `seekPreviewS` is one shared store field with (at least) two independent
 * writers: this reducer's own stick scrub, and `DockTransport.tsx`'s mouse
 * hover/drag over the timeline (added later - see that file's own doc
 * comment on the hover-preview feature). `useFrame` runs every frame
 * regardless of whether a session exists, so with no session (the ordinary
 * desktop/magic-window view - the ONLY view available before a headset is
 * ever donned, and the one this repo's own live verification runs in) this
 * branch ran on EVERY frame, and used to clear ANY non-null `previewS` it
 * saw - including one the dock's mouse hover had just written. Since a
 * frame is ~8-16 ms, the dock's hover preview was wiped back to `null`
 * within one frame of being set: perceptibly, it never appeared at all.
 * Live-verified: `store.getState().setSeekPreview(65)` reads back 65
 * immediately, but reads back `null` after a single forced frame
 * (`pump(1)`) with no XR session - reproducing the reported „Kapitelmarken
 * und Preview Bilder" symptom exactly, independent of chapter data.
 *
 * The original intent - "taking the headset off mid-scrub must not strand
 * the HUD showing a frozen preview" - only applies to a preview THIS
 * reducer's own gesture put there, which is exactly what
 * `state.seek.targetS !== null` records (non-null for as long as a stick
 * scrub is in flight; the branch below runs before `state` is replaced with
 * the reset `INITIAL_XR_PLAYER_INPUT_STATE`, so it still reflects the PRIOR
 * frame's gesture). Gating on that instead of on `input.previewS` leaves a
 * foreign preview (mouse hover, or anything else that might reuse this
 * field later) alone whenever this component never started a gesture of
 * its own - which is always true outside an XR session, since the stick
 * that drives `state.seek` does not exist without one.
 */
export function stepPlayerFrame(
  state: XRPlayerInputState,
  input: XRPlayerFrameInput,
): { state: XRPlayerInputState; effects: XRPlayerEffect[] } {
  if (!input.hasSession) {
    const effects: XRPlayerEffect[] = state.seek.targetS !== null ? [{ type: 'clearPreview' }] : []
    return { state: INITIAL_XR_PLAYER_INPUT_STATE, effects }
  }

  const effects: XRPlayerEffect[] = []
  const { state: playPause, fire } = stepPressLatch(state.playPause, input.primaryPressed)
  if (fire) effects.push({ type: 'togglePlay' })

  if (!input.hasEpisode) return { state: { ...state, playPause }, effects }

  const segments = input.segments.length > 0 ? input.segments : NO_SEGMENTS
  const { state: flick, steps } = stepChapterFlick(state.flick, input.yAxis)

  if (steps !== 0) {
    // From the scrub target when one is in flight, so a flick mid-scrub steps
    // from where the viewer is currently pointing rather than from the playhead
    // they have already scrubbed away from.
    const from = state.seek.targetS ?? input.currentTimeS
    const target = chapterSeekTarget(segments, from, steps)
    if (target !== null) {
      effects.push({ type: 'seek', seconds: target })
      if (input.previewS !== null) effects.push({ type: 'clearPreview' })
      return { state: { seek: suppressStickSeek(), flick, playPause }, effects }
    }
    // NO chapter that way (the last one, the first one, or a recording with
    // none at all). The flick is a silent no-op — and specifically it must NOT
    // abandon a scrub in flight: nothing happened, so there is nothing for the
    // scrub to have been superseded by, and destroying the viewer's gesture
    // because they twitched vertically at the end of the recording would be a
    // worse bug than the one the abandon exists to prevent. Falls through to
    // the scrub below with the seek state untouched.
  }

  const seekResult = stepStickSeek(state.seek, {
    xAxis: input.xAxis,
    delta: input.delta,
    currentTimeS: input.currentTimeS,
    durationS: input.durationS,
  })
  if (seekResult.commit !== null) {
    effects.push({ type: 'seek', seconds: seekResult.commit })
    if (input.previewS !== null) effects.push({ type: 'clearPreview' })
  } else if (seekResult.preview !== null) {
    // Quantized (see SEEK_PREVIEW_STEP), so this is skipped on most frames
    // rather than re-rendering every subscriber of `seekPreviewS` at 72-120 Hz.
    if (seekResult.preview !== input.previewS) {
      effects.push({ type: 'preview', seconds: seekResult.preview })
    }
  } else if (state.seek.targetS !== null && input.previewS !== null) {
    // The gesture ended without a commit — the duration went bad, or the base
    // was not finite. Leave nothing stranded in the HUD.
    effects.push({ type: 'clearPreview' })
  }

  return { state: { seek: seekResult.state, flick, playPause }, effects }
}
