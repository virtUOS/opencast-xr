/**
 * Decides WHEN the tutorial tour should start - as opposed to `tourState.ts`,
 * which only knows how to walk through it once it has.
 *
 * ## The rule (kiosk mode, from the conference brief)
 *
 * While the start overlay's tutorial toggle is on, the tour starts fresh
 * from step 1 on EVERY "start of the player" - every time a recording is
 * opened (a `'browse' -> 'player'` transition), AND every time a FRESH
 * immersive session begins while a recording is already open (the next
 * visitor dons the headset while the previous one's recording is still on
 * screen - "jeder neue Besucher setzt die Brille auf" is a fresh person who
 * has never seen it). There is deliberately no "already shown this
 * session/page load" suppression: „Der Tutorial Modus wird nur beim Ersten
 * mal nach dem Start der VR angezeigt. Ich wollte das für die Konferenz aber
 * bei jedem Start des Players" - a kiosk visitor should see it explained
 * every single time, not just the first, in the magic window exactly as much
 * as in a headset.
 *
 * An earlier round suppressed all of this after the first showing (an
 * incrementing `epoch`, a `shownForEpoch` marker, `markTourShown`) - that
 * machinery is gone. `tourStartDecision`'s SHAPE survives unchanged though:
 * two edge flags, the current mode, the toggle, still funnelled through one
 * shared decision (see its own doc comment for why) - the kiosk rule turned
 * out to be the simpler one to express, not a bigger state machine.
 *
 * ## The mechanism: two edges, one shared decision
 *
 * - `sessionStarted` - a genuine `'none' -> immersive` WebXR transition,
 *   reported by `advanceTourGate`'s `TourGateTransition`.
 * - `modeEdge` - a genuine `'browse' -> 'player'` transition in the player
 *   store's own `mode`.
 *
 * Both are EDGES, not levels: `mode === 'player'` staying true across an
 * unrelated store update, or a session staying active across an unrelated
 * `xrStore` update, must never re-trigger this - only the instant either one
 * actually flips does. `App.tsx`'s two effects each detect their own edge and
 * funnel through `tourStartDecision`, so the "is this actually player mode
 * right now" and "is the tutorial switched on" checks live in exactly one
 * place rather than being duplicated (and potentially drifting) between them.
 *
 * ## Why this never touches the persisted toggle
 *
 * `tutorialEnabled` is a PARAMETER to `tourStartDecision`, read live from
 * `tutorialPrefs.ts` by the caller - never stored in `TourGateState` itself.
 * Completing or skipping a shown tour must never flip that preference (only
 * the start overlay's own checkbox does - see that module's doc comment).
 *
 * ## Why this module knows nothing about WHEN it is called from
 *
 * No timers, no subscriptions, no import of `xrStore`/`App.tsx`/the player
 * store. `advanceTourGate` is meant to be fed every WebXR session-mode change
 * (`xrStore.subscribe` in `App.tsx`, mirroring `telemetry.ts`'s own
 * subscription there) and `tourStartDecision` is meant to be consulted at
 * both of the two moments its own doc comment names.
 */
export interface TourGateState {
  /** Whether an immersive session is active right now - the edge-detector `advanceTourGate` tracks. */
  xrActive: boolean
}

export const INITIAL_TOUR_GATE_STATE: TourGateState = { xrActive: false }

/** The WebXR session mode shape this module cares about - a subset of `@react-three/xr`'s own `XRState['mode']`. */
export type XrSessionMode = 'none' | 'immersive-vr' | 'immersive-ar'

/** `advanceTourGate`'s result: the gate's next state, and whether THIS call observed a fresh session start. */
export interface TourGateTransition {
  /** Always write this back to the caller's own gate ref, even when `sessionStarted` is `false`. */
  state: TourGateState
  /**
   * True exactly when `mode` reports a session that was not active a moment
   * ago (`'none'` -> an immersive mode) - a real "a session just started"
   * edge, not merely "a session happens to be active". A session ENDING
   * (immersive -> `'none'`) updates `state` but this is always `false` then:
   * ending is not the event the tour cares about, only starting is.
   */
  sessionStarted: boolean
}

/**
 * `'immersive-vr'` -> `'immersive-ar'` directly (or the reverse) is not a
 * transition this app's own code ever produces - `App.tsx`'s
 * `chooseBackgroundRow` always ends the running session first, so the mode
 * always passes through `'none'` on the way to the other one (see that
 * function's own doc comment for why re-entering directly is not attempted).
 * This function is still total over the type regardless: a direct switch
 * between the two immersive modes leaves `xrActive` true throughout and
 * therefore reports no session start either (a defensible reading - the
 * running session did not, from this state machine's perspective, ever stop)
 * even though the app's own flow never exercises it.
 */
export function advanceTourGate(state: TourGateState, mode: XrSessionMode): TourGateTransition {
  const nowActive = mode !== 'none'
  if (nowActive === state.xrActive) return { state, sessionStarted: false }
  return { state: { xrActive: nowActive }, sessionStarted: nowActive }
}

/** The player store's own `mode` field shape - duplicated rather than imported, same reasoning as `XrSessionMode` above: this module stays dependency-free. */
export type PlayerMode = 'browse' | 'player'

export interface TourStartDecisionInput {
  /** True exactly on the call that just observed `advanceTourGate` report a fresh immersive session start - NOT "an immersive session happens to be active". */
  sessionStarted: boolean
  /** True exactly on the call that just observed `mode` transition `'browse'` -> `'player'`. */
  modeEdge: boolean
  /** The CURRENT player mode, at the moment this is being asked. */
  mode: PlayerMode
  enabled: boolean
}

/**
 * Whether THIS event - a fresh immersive session starting, or player mode
 * being entered - should start the tour. The one decision both of
 * `App.tsx`'s effects (the `xrStore` subscription and the `mode`-edge watch)
 * call, so the two can never disagree about what counts as "a start of the
 * player" - see `App.tsx`'s `maybeStartTour` for the shared caller.
 *
 * `false` whenever the tutorial toggle is off, or `mode` is not currently
 * `'player'` - entering VR from the library (nothing open yet) must not
 * start the tour early; see the scenario below for exactly when the LATER
 * mode-edge call picks that case up instead. Otherwise `true` whenever
 * EITHER `sessionStarted` or `modeEdge` is set - there is no further
 * "already shown" check anymore (see this module's own doc comment for why).
 *
 * `sessionStarted` gives the epoch-bump event its own chance to start the
 * tour, gated on `mode === 'player'` right here (not merely "was player a
 * moment ago") - if a fresh session starts while still browsing, this
 * answers `false` and the mode-edge call fires later instead, when the
 * visitor actually opens a recording. That is what keeps "VR entered from
 * browse, then a recording is opened" a SINGLE start rather than two: the
 * session-start call sees `mode !== 'player'` and declines; the later
 * mode-edge call is the one that actually starts it.
 *
 * Neither flag alone is sufficient by itself: a call with BOTH `false` (an
 * unrelated store update) must never start the tour, so this refuses unless
 * at least one of them is true, in addition to the `enabled`/`mode` checks
 * above.
 */
export function tourStartDecision(input: TourStartDecisionInput): boolean {
  if (!input.enabled) return false
  if (input.mode !== 'player') return false
  return input.sessionStarted || input.modeEdge
}
