/**
 * The tutorial tour's own runtime state machine: which step (if any) is
 * showing, and how "Weiter"/"Fertig" and "Tutorial beenden" move it - pure and
 * unit-tested here, deliberately apart from `TourBubble.tsx` (which only
 * renders whatever this says) and from `tourGate.ts` (which decides WHEN to
 * dispatch `start` in the first place - see that module's own doc comment).
 *
 * Kept independent of `TOUR_STEPS.length`: this module takes the step count
 * as a parameter rather than importing `tourSteps.ts`, so a change to the
 * step list cannot silently desync from a hard-coded number here, and so this
 * file's own tests can exercise step counts `tourSteps.ts` never uses (0, 1)
 * without inventing fake step data.
 */
export interface TourRuntimeState {
  active: boolean
  stepIndex: number
}

export const INITIAL_TOUR_STATE: TourRuntimeState = { active: false, stepIndex: 0 }

export type TourAction = { type: 'start' } | { type: 'advance' } | { type: 'skip' }

/**
 * `start` always begins at step 0, regardless of the state it is dispatched
 * from - `tourGate.ts` only ever calls it while inactive, but a stray second
 * `start` (there is no code path for one today) restarting from the top
 * rather than resuming mid-sequence is the safer of the two readings.
 *
 * `advance` on the LAST step finishes the tour (`active: false`) rather than
 * requiring a separate `finish` action - the bubble's own "Fertig" label on
 * that step is cosmetic (see `isLastTourStep`), the action underneath it is
 * the same `advance` every other step's "Weiter" sends. `advance` while
 * inactive is a no-op: no code path dispatches it then, but a reducer should
 * not need a precondition to be safe to call.
 *
 * `skip` ends the tour from ANY step, including the first - "Tutorial
 * beenden" is on every step's bubble, per the brief.
 *
 * Finishing OR skipping resets `stepIndex` back to 0 (not left at wherever it
 * stopped): the next `start` should always begin at the top, and an inactive
 * state's `stepIndex` is otherwise meaningless - zeroing it here means
 * `INITIAL_TOUR_STATE` is the only "inactive" shape this reducer ever
 * produces, rather than one of several equivalent-but-different ones.
 */
export function reduceTour(state: TourRuntimeState, action: TourAction, stepCount: number): TourRuntimeState {
  switch (action.type) {
    case 'start':
      return { active: true, stepIndex: 0 }
    case 'advance': {
      if (!state.active) return state
      const next = state.stepIndex + 1
      if (next >= stepCount) return { active: false, stepIndex: 0 }
      return { active: true, stepIndex: next }
    }
    case 'skip':
      return state.active ? { active: false, stepIndex: 0 } : state
  }
}

/** Whether `state` is showing the last step - what decides "Weiter" vs "Fertig" on the bubble. */
export function isLastTourStep(state: TourRuntimeState, stepCount: number): boolean {
  return state.active && state.stepIndex === stepCount - 1
}
