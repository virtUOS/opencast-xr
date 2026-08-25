import { describe, it, expect } from 'vitest'
import type { OcSegment } from '../opencast/types'
import {
  INITIAL_FLICK_STATE,
  INITIAL_PRESS_LATCH,
  INITIAL_STICK_SEEK_STATE,
  SEEK_DEADZONE,
  SEEK_MAX_FRAME_DELTA,
  SEEK_MAX_RATE,
  SEEK_MIN_RATE,
  FLICK_ARM_THRESHOLD,
  FLICK_FIRE_THRESHOLD,
  chapterSeekTarget,
  stepChapterFlick,
  stepPressLatch,
  stepStickSeek,
  stickSeekRate,
  type FlickState,
  type PressLatchState,
  type StickSeekState,
} from './xrPlayerInput'

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance)

describe('stickSeekRate', () => {
  it('is exactly zero inside the deadzone, at either sign', () => {
    // Stick drift is the whole reason for the deadzone: a Quest stick at rest
    // reads a few hundredths off centre, and a rate that is merely SMALL there
    // would still walk the playhead away for as long as the app is open.
    for (const x of [0, 0.01, -0.05, SEEK_DEADZONE, -SEEK_DEADZONE]) {
      expect(stickSeekRate(x)).toBe(0)
    }
  })

  it('ramps from the gentle rate at the deadzone edge, not from a step', () => {
    // Just past the deadzone the rate must be SEEK_MIN_RATE (the gentle end),
    // never a jump to some fraction of the maximum - the same rescale-from-the-
    // deadzone-edge property stickYawDegrees has.
    close(stickSeekRate(SEEK_DEADZONE + 1e-9), SEEK_MIN_RATE, 1e-4)
  })

  it('reaches exactly the maximum at full deflection, and never exceeds it', () => {
    close(stickSeekRate(1), SEEK_MAX_RATE)
    close(stickSeekRate(-1), -SEEK_MAX_RATE)
    // A driver reporting past full scale must not outrun the cap.
    close(stickSeekRate(1.5), SEEK_MAX_RATE)
    close(stickSeekRate(-2), -SEEK_MAX_RATE)
  })

  it('is signed like the stick: right seeks forward, left seeks back', () => {
    expect(stickSeekRate(0.6)).toBeGreaterThan(0)
    expect(stickSeekRate(-0.6)).toBeLessThan(0)
    close(stickSeekRate(-0.6), -stickSeekRate(0.6))
  })

  it('is monotonic, and slow over most of the stick travel', () => {
    // The curve is what makes „schneller oder langsamer, je staerker ich den
    // Stick bewege" usable: a fast top end is only worth having if small
    // deflections stay fine-grained. Pinned as a property (monotonic, and the
    // midpoint well below the linear midpoint) rather than as sampled numbers,
    // so the exponent can be retuned without rewriting the test.
    let previous = 0
    for (let x = SEEK_DEADZONE + 0.01; x <= 1; x += 0.01) {
      const rate = stickSeekRate(x)
      expect(rate).toBeGreaterThan(previous)
      previous = rate
    }
    const linearMidpoint = (SEEK_MIN_RATE + SEEK_MAX_RATE) / 2
    expect(stickSeekRate((1 + SEEK_DEADZONE) / 2)).toBeLessThan(linearMidpoint)
  })

  it('honours tuned constants', () => {
    close(stickSeekRate(1, { maxRate: 120 }), 120)
    close(stickSeekRate(0.5, { deadzone: 0.6 }), 0)
  })
})

describe('stepStickSeek', () => {
  const run = (
    state: StickSeekState,
    xAxis: number,
    currentTimeS = 100,
    delta = 0.1,
    durationS = 600,
  ) => stepStickSeek(state, { xAxis, delta, currentTimeS, durationS })

  it('does nothing at all while the stick rests', () => {
    const result = run(INITIAL_STICK_SEEK_STATE, 0.05)
    expect(result.state).toEqual(INITIAL_STICK_SEEK_STATE)
    expect(result.preview).toBeNull()
    expect(result.commit).toBeNull()
  })

  it('previews a moving target while held, and does NOT seek', () => {
    // The point of the whole design: a video element asked to seek every frame
    // stalls, so the gesture scrubs a NUMBER and the element is only touched on
    // release. Same shape as the dock timeline drag (timelineDrag.ts).
    let state = INITIAL_STICK_SEEK_STATE
    const previews: number[] = []
    for (let i = 0; i < 10; i++) {
      const result = run(state, 1)
      state = result.state
      expect(result.commit).toBeNull()
      expect(result.preview).not.toBeNull()
      previews.push(result.preview!)
    }
    // Ten 0.1 s frames at full deflection: 1 s of holding at SEEK_MAX_RATE.
    close(previews[previews.length - 1], 100 + SEEK_MAX_RATE)
    // Strictly increasing - the target accumulates rather than being recomputed
    // from the (frozen, because we never seek) playhead each frame.
    for (let i = 1; i < previews.length; i++) expect(previews[i]).toBeGreaterThan(previews[i - 1])
  })

  it('commits exactly once, on release, and clears the preview', () => {
    let state = INITIAL_STICK_SEEK_STATE
    for (let i = 0; i < 5; i++) state = run(state, -1).state
    const target = state.targetS!
    close(target, 100 - SEEK_MAX_RATE * 0.5)

    const release = run(state, 0)
    expect(release.commit).not.toBeNull()
    close(release.commit!, target)
    expect(release.preview).toBeNull()
    expect(release.state).toEqual(INITIAL_STICK_SEEK_STATE)

    // A second resting frame must not commit again - the gesture is over.
    const after = run(release.state, 0)
    expect(after.commit).toBeNull()
  })

  it('starts each fresh gesture from the LIVE playhead, not from the last target', () => {
    // Between two gestures the video has been playing, so the second nudge must
    // be relative to where playback actually is now.
    let state = INITIAL_STICK_SEEK_STATE
    state = run(state, 1, 100).state
    state = run(state, 0, 100).state // release, back to idle
    const second = run(state, 1, 500)
    expect(second.preview!).toBeGreaterThan(500)
    expect(second.preview!).toBeLessThan(500 + SEEK_MAX_RATE)
  })

  it('clamps the target to the recording, and still commits at the edge', () => {
    let state = INITIAL_STICK_SEEK_STATE
    // 100 frames of full-right from 590 s of a 600 s recording.
    for (let i = 0; i < 100; i++) state = run(state, 1, 590, 0.1, 600).state
    close(state.targetS!, 600)
    close(run(state, 0, 590, 0.1, 600).commit!, 600)

    let back = INITIAL_STICK_SEEK_STATE
    for (let i = 0; i < 100; i++) back = run(back, -1, 5, 0.1, 600).state
    close(back.targetS!, 0)
  })

  it('clamps the frame delta, so a hitch cannot teleport the playhead', () => {
    // useFrame's delta is wall clock: a GC pause or a shader compile hands the
    // next frame half a second. Unclamped, one such frame at full deflection
    // would move the target by 15 s in a single step.
    const hitch = run(INITIAL_STICK_SEEK_STATE, 1, 100, 5)
    close(hitch.preview!, 100 + SEEK_MAX_RATE * SEEK_MAX_FRAME_DELTA)
    // A negative or NaN delta must not move it backwards or poison the target.
    expect(run(INITIAL_STICK_SEEK_STATE, 1, 100, -1).preview).toBe(100)
    expect(Number.isFinite(run(INITIAL_STICK_SEEK_STATE, 1, 100, NaN).preview!)).toBe(true)
  })

  it('is inert for a recording with no known duration', () => {
    // durationMs 0 (a stub episode, or metadata that never arrived) must not
    // produce a NaN preview or a seek to nowhere.
    const result = run(INITIAL_STICK_SEEK_STATE, 1, 0, 0.1, 0)
    expect(result.preview).toBe(0)
    expect(result.commit).toBeNull()
  })

  it('reverses direction within one gesture without releasing', () => {
    let state = INITIAL_STICK_SEEK_STATE
    for (let i = 0; i < 5; i++) state = run(state, 1).state
    const forwardTarget = state.targetS!
    for (let i = 0; i < 3; i++) state = run(state, -1).state
    expect(state.targetS!).toBeLessThan(forwardTarget)
    // Still one gesture, so still nothing committed.
    expect(run(state, -1).commit).toBeNull()
  })
})

describe('stepChapterFlick', () => {
  const flick = (state: FlickState, yAxis: number) => stepChapterFlick(state, yAxis)

  it('fires once on a deliberate flick, not once per frame while held', () => {
    // „Das aber nur mit dedizierter Bewegung. Also einmal stark bewegen springt
    // 1 Kapitel." - the whole requirement, as a test.
    let state = INITIAL_FLICK_STATE
    let fired = 0
    for (let i = 0; i < 30; i++) {
      const result = flick(state, -1)
      state = result.state
      fired += Math.abs(result.steps)
    }
    expect(fired).toBe(1)
  })

  it('re-arms only after the stick comes back near centre', () => {
    let state = INITIAL_FLICK_STATE
    expect(flick(state, -1).steps).toBe(-1)
    state = flick(state, -1).state

    // Half-way back is NOT enough - that is the hysteresis gap, and without it
    // a stick wobbling around the fire threshold would page through chapters.
    state = flick(state, -(FLICK_FIRE_THRESHOLD + FLICK_ARM_THRESHOLD) / 2).state
    expect(flick(state, -1).steps).toBe(0)

    state = flick(state, 0).state // properly released
    expect(flick(state, -1).steps).toBe(-1)
  })

  it('maps up to the previous chapter and down to the next', () => {
    // WebXR thumbstick yAxis is NEGATIVE up (the same convention sphere-shell's
    // dolly relies on: it negates yAxis to move forward). Up = previous is the
    // order the „Kapitel" window itself lists them in - earliest at the top.
    expect(flick(INITIAL_FLICK_STATE, -0.9).steps).toBe(-1)
    expect(flick(INITIAL_FLICK_STATE, 0.9).steps).toBe(1)
  })

  it('ignores a lazy push that never reaches the fire threshold', () => {
    let state = INITIAL_FLICK_STATE
    let fired = 0
    for (const y of [-0.3, -0.5, -0.7, -0.79, -0.5, 0]) {
      const result = flick(state, y)
      state = result.state
      fired += Math.abs(result.steps)
    }
    expect(fired).toBe(0)
  })

  it('a full sweep across centre fires each side once', () => {
    let state = INITIAL_FLICK_STATE
    const steps: number[] = []
    for (const y of [0, -1, -1, 0, 1, 1, 0, -1]) {
      const result = flick(state, y)
      state = result.state
      if (result.steps !== 0) steps.push(result.steps)
    }
    expect(steps).toEqual([-1, 1, -1])
  })

  it('starts armed, so the very first flick counts', () => {
    expect(INITIAL_FLICK_STATE.armed).toBe(true)
  })
})

describe('chapterSeekTarget', () => {
  const segments: OcSegment[] = [
    { startMs: 0, durationMs: 60_000, text: 'Eins' },
    { startMs: 60_000, durationMs: 60_000, text: 'Zwei' },
    { startMs: 120_000, durationMs: 60_000, text: 'Drei' },
  ]

  it('is a no-op for a recording with no chapters', () => {
    // Most of develop.opencast.org - the flick must simply do nothing rather
    // than seek to 0.
    expect(chapterSeekTarget([], 42, 1)).toBeNull()
    expect(chapterSeekTarget([], 42, -1)).toBeNull()
  })

  it('steps to the next chapter start', () => {
    expect(chapterSeekTarget(segments, 30, 1)).toBe(60)
    expect(chapterSeekTarget(segments, 90, 1)).toBe(120)
  })

  it('steps to the previous chapter start, symmetrically', () => {
    // Deliberately NOT the "restart the current chapter first" convention of a
    // media previous-track button: „einmal stark bewegen springt 1 Kapitel"
    // says one flick is one chapter, and an asymmetric back step would make
    // down-then-up land somewhere the user did not start.
    expect(chapterSeekTarget(segments, 130, -1)).toBe(60)
    expect(chapterSeekTarget(segments, 90, -1)).toBe(0)
  })

  it('round-trips: next then previous returns to the starting chapter', () => {
    const forward = chapterSeekTarget(segments, 30, 1)!
    expect(chapterSeekTarget(segments, forward, -1)).toBe(0)
  })

  it('stops at both ends rather than wrapping or clamping silently', () => {
    expect(chapterSeekTarget(segments, 150, 1)).toBeNull() // already in the last
    expect(chapterSeekTarget(segments, 10, -1)).toBeNull() // already in the first
  })

  it('handles a position before every chapter start', () => {
    const late: OcSegment[] = [{ startMs: 30_000, durationMs: 1000, text: 'Spaet' }]
    expect(chapterSeekTarget(late, 5, 1)).toBe(30)
    expect(chapterSeekTarget(late, 5, -1)).toBeNull()
  })

  it('is a no-op for a zero direction', () => {
    expect(chapterSeekTarget(segments, 90, 0)).toBeNull()
  })
})

describe('stepPressLatch', () => {
  it('fires on the rising edge only', () => {
    let state: PressLatchState = INITIAL_PRESS_LATCH
    const press = (pressed: boolean) => {
      const result = stepPressLatch(state, pressed)
      state = result.state
      return result.fire
    }
    expect(press(false)).toBe(false)
    expect(press(true)).toBe(true)
    // Held across many frames: a play/pause that toggled 72 times a second
    // would be unusable.
    for (let i = 0; i < 50; i++) expect(press(true)).toBe(false)
    expect(press(false)).toBe(false)
    expect(press(true)).toBe(true)
  })

  it('starts unpressed, so a button already held when the session opens does not fire', () => {
    expect(INITIAL_PRESS_LATCH.wasPressed).toBe(false)
    // Entering VR with a thumb on the button: the first observed frame is a
    // rising edge by definition, and that IS the honest reading - but the
    // latch must then hold until a real release.
    let state = stepPressLatch(INITIAL_PRESS_LATCH, true).state
    for (let i = 0; i < 10; i++) {
      const result = stepPressLatch(state, true)
      state = result.state
      expect(result.fire).toBe(false)
    }
  })
})
