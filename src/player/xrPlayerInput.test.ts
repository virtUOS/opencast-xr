import { describe, it, expect } from 'vitest'
import type { OcSegment } from '../opencast/types'
import {
  INITIAL_FLICK_STATE,
  INITIAL_PRESS_LATCH,
  INITIAL_STICK_SEEK_STATE,
  INITIAL_XR_PLAYER_INPUT_STATE,
  SEEK_DEADZONE,
  SEEK_MAX_FRAME_DELTA,
  SEEK_MAX_RATE,
  SEEK_MIN_RATE,
  SEEK_PREVIEW_STEP,
  FLICK_ARM_THRESHOLD,
  FLICK_FIRE_THRESHOLD,
  chapterSeekTarget,
  stepChapterFlick,
  stepPlayerFrame,
  stepPressLatch,
  stepStickSeek,
  stickSeekRate,
  suppressStickSeek,
  type FlickState,
  type PressLatchState,
  type StickSeekState,
  type XRPlayerFrameInput,
  type XRPlayerInputState,
} from './xrPlayerInput'

/** A flick state that has seen a centred stick, i.e. ready to fire. */
const ARMED_FLICK: FlickState = stepChapterFlick(INITIAL_FLICK_STATE, 0).state

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

  it('is inert for an unknown duration - on the RELEASE path too', () => {
    // `Episode.durationMs` is `Number(mp?.duration)` at the parse boundary, so
    // NaN is reachable from a real server response, and 0 from a stub episode.
    // Clamping either to a zero-length recording would make every release
    // commit seek(0) and throw the viewer to the start of the lecture.
    for (const durationS of [0, NaN, -5, Infinity]) {
      const held = run(INITIAL_STICK_SEEK_STATE, 1, 100, 0.1, durationS)
      expect(held.preview).toBeNull()
      expect(held.commit).toBeNull()
      expect(held.state).toEqual(INITIAL_STICK_SEEK_STATE)

      // And the release path: even a gesture that somehow carried a target in
      // (a duration that went bad mid-scrub) must not commit.
      const release = run({ targetS: 250, suppressed: false }, 0, 100, 0.1, durationS)
      expect(release.commit).toBeNull()
      expect(release.preview).toBeNull()
    }
  })

  it('is inert for a non-finite playhead, rather than seeking to 0', () => {
    const result = run(INITIAL_STICK_SEEK_STATE, 1, NaN)
    expect(result.preview).toBeNull()
    expect(result.commit).toBeNull()
    expect(result.state.targetS).toBeNull()
  })

  it('quantizes the PREVIEW but commits the exact target', () => {
    // The preview is what gets written to the store every frame; rounding it
    // to a quarter second is what stops it re-rendering every subscriber at
    // 72-120 Hz. The commit must stay exact.
    let state = INITIAL_STICK_SEEK_STATE
    const previews: (number | null)[] = []
    for (let i = 0; i < 12; i++) {
      const result = run(state, 0.5, 100, 1 / 90)
      state = result.state
      previews.push(result.preview)
      // Always on the grid...
      const steps = result.preview! / SEEK_PREVIEW_STEP
      close(steps, Math.round(steps))
    }
    // ...and therefore repeats itself across frames rather than changing on
    // every one, which is the whole point.
    expect(new Set(previews).size).toBeLessThan(previews.length)
    // The state kept the exact value, not the rounded one.
    expect(state.targetS! % SEEK_PREVIEW_STEP).not.toBe(0)
    close(run(state, 0, 100).commit!, state.targetS!)
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
    let state = ARMED_FLICK
    let fired = 0
    for (let i = 0; i < 30; i++) {
      const result = flick(state, -1)
      state = result.state
      fired += Math.abs(result.steps)
    }
    expect(fired).toBe(1)
  })

  it('re-arms only after the stick comes back near centre', () => {
    let state = ARMED_FLICK
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
    expect(flick(ARMED_FLICK, -0.9).steps).toBe(-1)
    expect(flick(ARMED_FLICK, 0.9).steps).toBe(1)
  })

  it('ignores a lazy push that never reaches the fire threshold', () => {
    let state = ARMED_FLICK
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

  it('starts DISARMED, so a stick already deflected at mount cannot fire', () => {
    // Same discipline as INITIAL_PRESS_LATCH. This state is built with no
    // knowledge of where the stick physically is - a thumb resting on a
    // deflected stick as the session opens must not jump a chapter before the
    // viewer has deliberately done anything.
    expect(INITIAL_FLICK_STATE.armed).toBe(false)
    let state = INITIAL_FLICK_STATE
    let fired = 0
    for (let i = 0; i < 10; i++) {
      const result = flick(state, -1)
      state = result.state
      fired += Math.abs(result.steps)
    }
    expect(fired).toBe(0)
    // One centred frame arms it, and then it behaves exactly as before.
    state = flick(state, 0).state
    expect(flick(state, -1).steps).toBe(-1)
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

  it('steps in TIME order even when the segments arrive unsorted', () => {
    // activeSegmentIndex is robust to unsorted input, but `active + 1` is a
    // step in ARRAY order - so without sorting first, "the next chapter" was
    // whatever happened to be stored next, which for this input is the one
    // BEFORE the current position.
    const shuffled: OcSegment[] = [
      { startMs: 120_000, durationMs: 60_000, text: 'Drei' },
      { startMs: 0, durationMs: 60_000, text: 'Eins' },
      { startMs: 60_000, durationMs: 60_000, text: 'Zwei' },
    ]
    expect(chapterSeekTarget(shuffled, 30, 1)).toBe(60)
    expect(chapterSeekTarget(shuffled, 90, 1)).toBe(120)
    expect(chapterSeekTarget(shuffled, 130, -1)).toBe(60)
    expect(chapterSeekTarget(shuffled, 150, 1)).toBeNull()
    expect(chapterSeekTarget(shuffled, 10, -1)).toBeNull()
  })

  it('does not mutate the caller\'s segments array', () => {
    const shuffled: OcSegment[] = [
      { startMs: 60_000, durationMs: 1000, text: 'B' },
      { startMs: 0, durationMs: 1000, text: 'A' },
    ]
    const before = shuffled.map((s) => s.text)
    chapterSeekTarget(shuffled, 30, 1)
    expect(shuffled.map((s) => s.text)).toEqual(before)
  })
})

describe('suppressStickSeek', () => {
  it('drops any target and blocks a new gesture until the stick centres', () => {
    // The flick's return path is the whole reason this exists: a push to
    // |y| >= 0.8 comes back through positions whose |x| is well past the seek
    // deadzone, and without the latch that return started a scrub which
    // committed a seek back towards the chapter just left.
    let state = suppressStickSeek()
    expect(state.targetS).toBeNull()
    expect(state.suppressed).toBe(true)

    // The return path: still deflected. Nothing previews, nothing commits.
    for (const x of [0.9, 0.7, 0.45, 0.3]) {
      const result = stepStickSeek(state, { xAxis: x, delta: 0.1, currentTimeS: 60, durationS: 600 })
      state = result.state
      expect(result.preview).toBeNull()
      expect(result.commit).toBeNull()
      expect(state.targetS).toBeNull()
    }

    // Centred: the latch clears, WITHOUT committing anything.
    const centred = stepStickSeek(state, { xAxis: 0.05, delta: 0.1, currentTimeS: 60, durationS: 600 })
    expect(centred.commit).toBeNull()
    expect(centred.state).toEqual(INITIAL_STICK_SEEK_STATE)

    // And a genuinely new push now works normally.
    const fresh = stepStickSeek(centred.state, { xAxis: 1, delta: 0.1, currentTimeS: 60, durationS: 600 })
    expect(fresh.preview).not.toBeNull()
    expect(fresh.state.targetS).toBeGreaterThan(60)
  })
})

describe('stepPlayerFrame', () => {
  const segments: OcSegment[] = [
    { startMs: 0, durationMs: 60_000, text: 'Eins' },
    { startMs: 60_000, durationMs: 60_000, text: 'Zwei' },
    { startMs: 120_000, durationMs: 60_000, text: 'Drei' },
  ]

  /**
   * Drives the reducer the way the component does, against a model of the two
   * clocks that actually exist at runtime:
   *
   * - `engine` — the master element's own `currentTime`, which `SyncEngine.seek`
   *   writes SYNCHRONOUSLY, so it is correct on the very next frame.
   * - `mirror` — the store's `currentTimeS`, refreshed by a 250 ms interval.
   *   Deliberately never updated here, so any test that passes is proof the
   *   reducer is not reading it. This is the C1 regression harness.
   */
  function driver(options: { durationS?: number; segments?: OcSegment[]; engine?: number } = {}) {
    let state: XRPlayerInputState = INITIAL_XR_PLAYER_INPUT_STATE
    let engine = options.engine ?? 30
    let previewS: number | null = null
    let playing = false
    const seeks: number[] = []

    const frame = (partial: Partial<XRPlayerFrameInput> = {}) => {
      const input: XRPlayerFrameInput = {
        hasSession: true,
        hasEpisode: true,
        xAxis: 0,
        yAxis: 0,
        primaryPressed: false,
        delta: 0.1,
        currentTimeS: engine,
        durationS: options.durationS ?? 600,
        segments: options.segments ?? segments,
        previewS,
        ...partial,
      }
      const result = stepPlayerFrame(state, input)
      state = result.state
      for (const effect of result.effects) {
        if (effect.type === 'seek') {
          engine = effect.seconds // synchronous, exactly like SyncEngine.seek
          seeks.push(effect.seconds)
        } else if (effect.type === 'preview') previewS = effect.seconds
        else if (effect.type === 'clearPreview') previewS = null
        else if (effect.type === 'togglePlay') playing = !playing
      }
      return result
    }

    // One centred frame to arm the flick (INITIAL_FLICK_STATE is disarmed).
    frame()
    return {
      frame,
      seeks,
      get engine() { return engine },
      get previewS() { return previewS },
      get playing() { return playing },
      get state() { return state },
    }
  }

  it('C1 TRACE 1: a chapter jump is not undone by the flick\'s own return path', () => {
    // The reported bug, end to end. Flick down from 30 s (chapter 1) -> seek to
    // 60 s. The thumb then returns to centre along a diagonal, sweeping the
    // horizontal axis past the deadzone. That return must not start a scrub,
    // and must not commit a seek back towards 30 s.
    const d = driver()
    d.frame({ yAxis: 1 })
    expect(d.seeks).toEqual([60])
    expect(d.engine).toBe(60)

    // The return path: still strongly deflected on BOTH axes.
    for (const [x, y] of [[0.9, 0.7], [0.75, 0.5], [0.5, 0.3], [0.3, 0.15]] as const) {
      d.frame({ xAxis: x, yAxis: y })
    }
    // Centred at last - this is where the bug used to commit its seek.
    d.frame({ xAxis: 0.05, yAxis: 0 })

    expect(d.seeks).toEqual([60]) // still exactly one seek
    expect(d.engine).toBe(60)
    expect(d.previewS).toBeNull()
  })

  it('C1 TRACE 2: a reverse scrub within the mirror\'s 250 ms lag does not undo the first', () => {
    // Scrub right from 30 s and release, then immediately scrub LEFT. The store
    // mirror still says 30 s for up to a quarter second; a gesture based on it
    // would scrub from 30 and land back near where it started, silently undoing
    // the first seek.
    const d = driver()
    for (let i = 0; i < 5; i++) d.frame({ xAxis: 1 })
    d.frame({ xAxis: 0 }) // release -> commit
    const first = d.seeks[0]
    expect(first).toBeGreaterThan(40) // 5 frames x 0.1 s x 30 s/s = +15 s
    expect(d.engine).toBe(first)

    // Immediately back the other way, for fewer frames than the first gesture.
    for (let i = 0; i < 2; i++) d.frame({ xAxis: -1 })
    d.frame({ xAxis: 0 })

    expect(d.seeks).toHaveLength(2)
    // Lands just short of the first target, NOT back near the original 30 s.
    expect(d.seeks[1]).toBeLessThan(first)
    expect(d.seeks[1]).toBeGreaterThan(first - 10)
    expect(d.seeks[1]).toBeGreaterThan(35)
  })

  it('C1 TRACE 3: two flicks in quick succession advance TWO chapters', () => {
    // With the store mirror the second flick re-read the pre-seek position and
    // resolved to the same chapter again, so it was a no-op.
    const d = driver()
    d.frame({ yAxis: 1 })
    expect(d.seeks).toEqual([60])
    d.frame({ yAxis: 0 }) // re-arm
    d.frame({ yAxis: 1 })
    expect(d.seeks).toEqual([60, 120])
    expect(d.engine).toBe(120)
  })

  it('I2: a no-op flick leaves an in-flight scrub alone', () => {
    // Flicking forward from inside the LAST chapter finds nothing. That must
    // not destroy a scrub the viewer is in the middle of.
    const d = driver({ engine: 150 }) // inside chapter 3, the last one
    for (let i = 0; i < 4; i++) d.frame({ xAxis: 1 })
    const scrubbed = d.state.seek.targetS
    expect(scrubbed).not.toBeNull()

    d.frame({ xAxis: 1, yAxis: 1 }) // flick forward: nowhere to go
    expect(d.seeks).toEqual([]) // no chapter seek
    expect(d.state.seek.targetS).not.toBeNull() // the gesture survived
    expect(d.state.seek.targetS!).toBeGreaterThan(scrubbed!)

    d.frame({ xAxis: 0, yAxis: 0 }) // release commits the scrub as normal
    expect(d.seeks).toHaveLength(1)
    expect(d.seeks[0]).toBeGreaterThan(150)
  })

  it('I2: a no-op flick on a recording with NO chapters leaves the scrub alone', () => {
    const d = driver({ segments: [] })
    for (let i = 0; i < 3; i++) d.frame({ xAxis: 1 })
    d.frame({ xAxis: 1, yAxis: -1 })
    expect(d.seeks).toEqual([])
    expect(d.state.seek.targetS).not.toBeNull()
    d.frame({ xAxis: 0, yAxis: 0 })
    expect(d.seeks).toHaveLength(1)
  })

  it('a REAL flick does abandon the scrub, and commits only the chapter', () => {
    // The other side of I2: when the flick actually goes somewhere, one gesture
    // must have one outcome.
    const d = driver()
    for (let i = 0; i < 4; i++) d.frame({ xAxis: 1 })
    expect(d.previewS).not.toBeNull()

    d.frame({ xAxis: 1, yAxis: 1 })
    expect(d.seeks).toEqual([60])
    expect(d.previewS).toBeNull() // the scrub's preview was cleared
    expect(d.state.seek.suppressed).toBe(true)

    d.frame({ xAxis: 0, yAxis: 0 })
    expect(d.seeks).toEqual([60]) // no second, contradictory seek
  })

  it('I1: an unknown duration never commits a seek to 0', () => {
    const d = driver({ durationS: NaN })
    for (let i = 0; i < 5; i++) d.frame({ xAxis: 1 })
    d.frame({ xAxis: 0 })
    expect(d.seeks).toEqual([])
    expect(d.previewS).toBeNull()
  })

  it('writes the preview only when the quantized value actually changes', () => {
    // The re-render cut. At 90 Hz and a gentle deflection, most frames move the
    // target by far less than SEEK_PREVIEW_STEP.
    const d = driver()
    let writes = 0
    for (let i = 0; i < 30; i++) {
      const result = d.frame({ xAxis: 0.45, delta: 1 / 90 })
      writes += result.effects.filter((e) => e.type === 'preview').length
    }
    expect(writes).toBeGreaterThan(0)
    expect(writes).toBeLessThan(10) // vs 30 without quantization
  })

  it('toggles play/pause once per press, and works with no episode open', () => {
    const d = driver()
    d.frame({ primaryPressed: true })
    expect(d.playing).toBe(true)
    for (let i = 0; i < 20; i++) d.frame({ primaryPressed: true })
    expect(d.playing).toBe(true) // held, not re-toggled
    d.frame({ primaryPressed: false })
    d.frame({ primaryPressed: true })
    expect(d.playing).toBe(false)

    // Browse mode: still the one binding that works.
    const browse = driver()
    browse.frame({ hasEpisode: false, primaryPressed: true })
    expect(browse.playing).toBe(true)
    expect(browse.seeks).toEqual([])
  })

  it('resets everything and clears a stranded preview when the session ends', () => {
    const d = driver()
    for (let i = 0; i < 4; i++) d.frame({ xAxis: 1 })
    expect(d.previewS).not.toBeNull()

    d.frame({ hasSession: false })
    expect(d.previewS).toBeNull()
    expect(d.state).toEqual(INITIAL_XR_PLAYER_INPUT_STATE)
    expect(d.seeks).toEqual([]) // an interrupted gesture must not commit

    // And a second no-session frame does not keep writing to the store.
    const again = d.frame({ hasSession: false })
    expect(again.effects).toEqual([])
  })

  it('does not clobber a preview it never set when there is no session (the dock\'s mouse hover)', () => {
    // The reported bug: DockTransport.tsx's mouse hover/drag over the
    // timeline writes the SAME store.seekPreviewS field this reducer does,
    // and `useFrame` runs every frame regardless of whether an XR session
    // exists - i.e. on every ordinary desktop/magic-window view, which is
    // the ONLY view available before a headset is ever donned. This
    // component must never have started a stick gesture of its own here
    // (`state.seek.targetS` is null from `INITIAL_XR_PLAYER_INPUT_STATE`),
    // so a `previewS` arriving from elsewhere must be left alone - unlike
    // the "stranded scrub" case above, where THIS reducer's own gesture
    // really was in flight when the session ended.
    const d = driver()
    const result = d.frame({ hasSession: false, previewS: 42 })
    expect(result.effects).toEqual([])

    // Holds across many consecutive no-session frames too, not just one.
    for (let i = 0; i < 10; i++) {
      expect(d.frame({ hasSession: false, previewS: 42 }).effects).toEqual([])
    }
  })

  it('does nothing at all on a resting frame', () => {
    const d = driver()
    expect(d.frame().effects).toEqual([])
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
