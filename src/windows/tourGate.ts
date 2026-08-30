/**
 * Decides WHEN the tutorial tour should start - as opposed to `tourState.ts`,
 * which only knows how to walk through it once it has.
 *
 * ## The rule, from the brief
 *
 * „Wenn der Player geöffnet wird" the tour should appear - but not on every
 * single episode change, or a viewer who opens a second recording mid-visit
 * would sit through the same seven-step tour twice in a row. The agreed rule
 * has two halves:
 *
 * - **Inside an immersive session**, the tour starts every time a NEW session
 *   begins and the player is then opened - "jeder neue Besucher setzt die
 *   Brille auf" is a fresh person who has never seen it, so re-showing per
 *   session (not per page load) is the point, not a bug to suppress.
 * - **In the magic window** (no immersive session - a desktop/tablet visit,
 *   which this project treats as a first-class way to use the app, not a
 *   fallback - see `App.tsx`'s own background-choice comment), there is no
 *   "new visitor" signal at all, so it shows once per PAGE LOAD instead:
 *   opening a second recording in the same tab does not repeat it.
 *
 * ## The mechanism: an epoch, bumped once per fresh immersive session
 *
 * `epoch` starts at 0 - "no session yet this page load", which is also the
 * permanent state of a magic-window visit. It is bumped by exactly one every
 * time `advanceTourGateEpoch` sees the WebXR session mode transition from
 * `'none'` to an immersive one - i.e. a session actually STARTING, not merely
 * being active. `shownForEpoch` records which epoch the tour was last shown
 * for (or `null`, never); `shouldShowTour` is simply "the tutorial is on, and
 * the current epoch has not had its tour yet".
 *
 * A magic-window visit never bumps the epoch (it stays 0 for the whole page
 * load), so `shownForEpoch` reaching 0 - after the FIRST player-mode entry -
 * is what makes every later one in the same tab a no-op: exactly the "once
 * per page load" half of the rule. Entering a fresh immersive session bumps
 * the epoch, so `shownForEpoch` (still pointing at the last epoch it fired
 * for) no longer matches, and the very first player-mode entry of that new
 * session shows the tour again: the "every new visitor" half.
 *
 * This module is agnostic of WHEN it is called from - it holds no timers, no
 * subscriptions, and does not import `xrStore`/`App.tsx`. `advanceTourGateEpoch`
 * is meant to be fed every WebXR session-mode change (`xrStore.subscribe` in
 * `App.tsx`, mirroring `telemetry.ts`'s own subscription there) and
 * `shouldShowTour`/`markTourShown` are meant to be consulted exactly at the
 * moment player mode is entered (the player store's `mode` becoming
 * `'player'`).
 *
 * ## Why this never touches the persisted toggle
 *
 * `tutorialEnabled` is a PARAMETER to `shouldShowTour`, read live from
 * `tutorialPrefs.ts` by the caller - never stored in `TourGateState` itself.
 * Completing or skipping a shown tour must never flip that preference (only
 * the start overlay's own checkbox does - see that module's doc comment), and
 * keeping the two concerns in separate places is what makes that true by
 * construction rather than by a rule someone has to remember not to break.
 */
export interface TourGateState {
  /** Bumped by one on every FRESH immersive session start. 0 for the whole of a magic-window page load. */
  epoch: number
  /** Whether an immersive session is active right now - the edge-detector `advanceTourGateEpoch` bumps `epoch` on. */
  xrActive: boolean
  /** The epoch the tour was last shown for, or `null` if it never has been this page load. */
  shownForEpoch: number | null
}

export const INITIAL_TOUR_GATE_STATE: TourGateState = {
  epoch: 0,
  xrActive: false,
  shownForEpoch: null,
}

/** The WebXR session mode shape this module cares about - a subset of `@react-three/xr`'s own `XRState['mode']`. */
export type XrSessionMode = 'none' | 'immersive-vr' | 'immersive-ar'

/**
 * Advances the epoch exactly when `mode` reports a session that was not
 * active a moment ago (`'none'` -> an immersive mode) - a real "a session
 * just started" edge, not merely "a session happens to be active". A session
 * ENDING (immersive -> `'none'`) updates `xrActive` but never bumps the
 * epoch: ending is not the event this tour cares about, only starting is.
 *
 * `'immersive-vr'` -> `'immersive-ar'` directly (or the reverse) is not a
 * transition this app's own code ever produces - `App.tsx`'s
 * `chooseBackgroundRow` always ends the running session first, so the mode
 * always passes through `'none'` on the way to the other one (see that
 * function's own doc comment for why re-entering directly is not attempted).
 * This function is still total over the type regardless: a direct switch
 * between the two immersive modes leaves `xrActive` true throughout and
 * therefore does not bump the epoch either, which is a defensible reading
 * (the running session did not, from this state machine's perspective, ever
 * stop) even though the app's own flow never exercises it.
 */
export function advanceTourGateEpoch(state: TourGateState, mode: XrSessionMode): TourGateState {
  const nowActive = mode !== 'none'
  if (nowActive === state.xrActive) return state
  if (nowActive) return { ...state, xrActive: true, epoch: state.epoch + 1 }
  return { ...state, xrActive: false }
}

/**
 * Whether entering player mode right now should start the tour. `false`
 * whenever the tutorial is switched off, regardless of epoch - and otherwise
 * `true` at most once per epoch, per the doc comment above.
 */
export function shouldShowTour(state: TourGateState, tutorialEnabled: boolean): boolean {
  if (!tutorialEnabled) return false
  return state.shownForEpoch !== state.epoch
}

/** Records that the tour was just shown, for the gate's CURRENT epoch - call this exactly when (not before) the tour actually starts. */
export function markTourShown(state: TourGateState): TourGateState {
  return { ...state, shownForEpoch: state.epoch }
}
