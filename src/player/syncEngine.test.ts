import { describe, expect, it, vi } from 'vitest'
import type { VideoLike } from './videoLike'
import {
  CATCHUP_RATE,
  DRIFT_IGNORE_S,
  DRIFT_SEEK_S,
  SLOWDOWN_RATE,
  SyncEngine,
  electMaster,
} from './syncEngine'

/**
 * Minimal VideoLike implementation for driving the engine with no DOM and no
 * timers. `advance(dt)` is the only thing that moves `currentTime`, and only
 * while "playing" (paused === false) - by `dt * playbackRate`, which is what
 * makes drift-catchup convergence testable step by step.
 */
class FakeVideo implements VideoLike {
  currentTime = 0
  playbackRate = 1
  muted = false
  volume = 1
  paused = true
  readyState = 4 // HAVE_ENOUGH_DATA by default; tests drop this below 3 to simulate a stall
  /**
   * How often pause() was CALLED, not how often it changed anything. A real
   * <video> fires a `pause` event and interrupts decoding on every call, so a
   * redundant pause (immediately undone by a play()) is visible jank a
   * paused-state assertion can't catch.
   */
  pauseCalls = 0

  play(): void {
    this.paused = false
  }

  pause(): void {
    this.pauseCalls++
    this.paused = true
  }

  advance(dt: number): void {
    if (!this.paused) this.currentTime += dt * this.playbackRate
  }
}

/**
 * The binding invariant across every stall-related test: the engine must
 * never claim it's still catching up on buffering while something is
 * actually running. If the engine intends to play and any of the given
 * videos is under-buffered, EVERY one of them must be paused right now -
 * regardless of whether that pause came from the stall mechanism or from
 * something else (a manually-paused video, by definition, is already
 * paused, so it never violates this). Call after any engine call that
 * could change buffering or a video's paused state.
 */
function assertStallInvariant(engine: SyncEngine, videos: FakeVideo[]): void {
  const isBuffering = videos.some((v) => v.readyState < 3)
  if (engine.playing && isBuffering) {
    for (const v of videos) expect(v.paused).toBe(true)
  }
}

/**
 * The audio-discipline invariant: across any handover, EXACTLY ONE of the
 * currently-registered streams carries audio (unmuted), and it is the master -
 * or none at all once the registry is empty. Pass only the ids that are
 * registered right now; already-departed elements are asserted separately
 * (they're muted on the way out, but they're no longer the engine's business).
 */
function assertAudioDiscipline(engine: SyncEngine, registered: Record<string, FakeVideo>): void {
  const unmuted = Object.entries(registered)
    .filter(([, v]) => !v.muted)
    .map(([id]) => id)
  expect(unmuted).toEqual(engine.masterId === null ? [] : [engine.masterId])
}

describe('SyncEngine: registration, master election, mute/volume discipline', () => {
  it('(a) master is chosen by lowest preference, regardless of registration order', () => {
    const engine = new SyncEngine()
    const presentation = new FakeVideo()
    const presenter = new FakeVideo()

    engine.register('presentation', presentation, 1)
    engine.register('presenter', presenter, 0)

    expect(engine.masterId).toBe('presenter')
  })

  it('(b) the master stays stable when a lower-priority slave joins afterwards', () => {
    const engine = new SyncEngine()
    const presenter = new FakeVideo()
    engine.register('presenter', presenter, 0)

    const screen = new FakeVideo()
    engine.register('screen', screen, 2)

    expect(engine.masterId).toBe('presenter')
  })

  it('(c) only the master is unmuted; every slave is muted', () => {
    const engine = new SyncEngine()
    const presenter = new FakeVideo()
    const screen = new FakeVideo()
    engine.register('presenter', presenter, 0)
    engine.register('screen', screen, 2)

    expect(presenter.muted).toBe(false)
    expect(screen.muted).toBe(true)
  })

  it('(d) setVolume touches the master only; slaves are untouched', () => {
    const engine = new SyncEngine()
    const presenter = new FakeVideo()
    const screen = new FakeVideo()
    engine.register('presenter', presenter, 0)
    engine.register('screen', screen, 2)
    screen.volume = 1

    engine.setVolume(0.4)

    expect(presenter.volume).toBe(0.4)
    expect(screen.volume).toBe(1)
  })

  it('(d2) volume getter reports the last value passed to setVolume, defaulting to 1', () => {
    const engine = new SyncEngine()
    expect(engine.volume).toBe(1)
    engine.setVolume(0.4)
    expect(engine.volume).toBe(0.4)
  })

  it('(e) onMasterChange fires with the new master id on election, and with null after the master unregisters', () => {
    const onMasterChange = vi.fn()
    const engine = new SyncEngine({ onMasterChange })
    const presenter = new FakeVideo()
    engine.register('presenter', presenter, 0)
    expect(onMasterChange).toHaveBeenCalledWith('presenter')

    engine.unregister('presenter')
    expect(onMasterChange).toHaveBeenCalledWith(null)
    expect(engine.masterId).toBeNull()
  })

  it('(f) currentTime returns the master time while registered, and the last known time once the registry is empty', () => {
    const engine = new SyncEngine()
    const presenter = new FakeVideo()
    engine.register('presenter', presenter, 0)
    presenter.currentTime = 12.5

    expect(engine.currentTime).toBe(12.5)

    engine.unregister('presenter')
    expect(engine.currentTime).toBe(12.5)
  })

  it('(g) [fix C1] re-registering the CURRENT master under the same id, same object, does not mute it', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    engine.register('master', master, 0)
    expect(master.muted).toBe(false)

    // A React ref re-firing, a StrictMode double-invoke, or anything else
    // that calls register() again for the id that's already master.
    engine.register('master', master, 0)

    expect(engine.masterId).toBe('master')
    expect(master.muted).toBe(false)
  })

  it('(h) [fix C1] re-registering the master id under a FRESH element (a swap) keeps it master, unmuted, at the master volume', () => {
    const engine = new SyncEngine()
    const original = new FakeVideo()
    engine.register('master', original, 0)
    engine.setVolume(0.3)

    const replacement = new FakeVideo() // a brand new element under the same stable id
    engine.register('master', replacement, 0)

    expect(engine.masterId).toBe('master')
    expect(replacement.muted).toBe(false)
    expect(replacement.volume).toBe(0.3)
  })
})

describe('SyncEngine: drift bands (tick)', () => {
  function mkMasterAndSlave() {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()
    return { engine, master, slave }
  }

  it(`(a) drift of 0.03s (inside DRIFT_IGNORE_S = ${DRIFT_IGNORE_S}) does nothing: rate stays 1`, () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 10
    slave.currentTime = 10 - 0.03

    engine.tick()

    expect(slave.playbackRate).toBe(1)
  })

  it(`(b) drift of 0.2s behind sets CATCHUP_RATE = ${CATCHUP_RATE}, and it returns to exactly 1 once the slave has caught up`, () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 10
    slave.currentTime = 10 - 0.2

    engine.tick()
    expect(slave.playbackRate).toBe(CATCHUP_RATE)

    // Advance both by the same wall-clock step: master at rate 1, slave at
    // CATCHUP_RATE - the slave gains ground exactly as advance()'s contract
    // promises (dt * playbackRate), which is what closes the drift.
    for (let i = 0; i < 50 && Math.abs(slave.currentTime - master.currentTime) > DRIFT_IGNORE_S; i++) {
      master.advance(0.1)
      slave.advance(0.1)
      engine.tick()
    }

    expect(Math.abs(slave.currentTime - master.currentTime)).toBeLessThanOrEqual(DRIFT_IGNORE_S)
    expect(slave.playbackRate).toBe(1)
  })

  it(`(c) drift of 0.8s (past DRIFT_SEEK_S = ${DRIFT_SEEK_S}) hard-seeks the slave to the master's time and resets rate to 1`, () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 10
    slave.currentTime = 10 - 0.8

    engine.tick()

    expect(slave.currentTime).toBe(10)
    expect(slave.playbackRate).toBe(1)
  })

  it(`(d) drift of 0.2s AHEAD sets SLOWDOWN_RATE = ${SLOWDOWN_RATE}`, () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 10
    slave.currentTime = 10 + 0.2

    engine.tick()

    expect(slave.playbackRate).toBe(SLOWDOWN_RATE)
  })

  it('(e) drift correction never touches the master itself', () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 10
    slave.currentTime = 10 - 0.8 // would seek the slave

    engine.tick()

    expect(master.playbackRate).toBe(1)
    expect(master.currentTime).toBe(10) // untouched, not seeked to itself or anything else
  })

  it(`(f) boundary: drift exactly at DRIFT_IGNORE_S = ${DRIFT_IGNORE_S} is still ignored (rate 1)`, () => {
    const { engine, master, slave } = mkMasterAndSlave()
    // Constructed as master - slave = DRIFT_IGNORE_S via a single negation,
    // not a subtraction of two arbitrary floats, so the drift lands on
    // exactly 0.05 with no floating-point rounding surprises at the boundary.
    master.currentTime = DRIFT_IGNORE_S
    slave.currentTime = 0

    engine.tick()

    expect(slave.playbackRate).toBe(1)
    expect(slave.currentTime).toBe(0) // not seeked
  })

  it(`(g) boundary: drift exactly at DRIFT_SEEK_S = ${DRIFT_SEEK_S} already hard-seeks (inclusive)`, () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = DRIFT_SEEK_S
    slave.currentTime = 0

    engine.tick()

    expect(slave.currentTime).toBe(DRIFT_SEEK_S)
    expect(slave.playbackRate).toBe(1)
  })

  it('(h) [fix I4] drift correction skips a slave paused independently of engine intent - no hard-seek storm on an idle element', () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 0
    slave.currentTime = 0
    slave.pause() // something outside the engine paused just this one stream

    // The master keeps advancing every tick; without the fix each tick past
    // DRIFT_SEEK_S would hard-seek the (idle, paused) slave.
    for (let i = 0; i < 20; i++) {
      master.advance(0.5) // master.paused is false, so this actually advances it
      engine.tick()
    }

    expect(master.currentTime).toBe(10) // 20 * 0.5, sanity check the loop ran
    expect(slave.currentTime).toBe(0) // never touched despite 10s of drift
    expect(slave.playbackRate).toBe(1) // never touched either
    expect(slave.paused).toBe(true) // still exactly as it was left

    // Once resumed, the very next tick applies the normal bands - here, a
    // hard seek, since drift (10s) is far past DRIFT_SEEK_S.
    slave.play()
    engine.tick()

    expect(slave.currentTime).toBe(10)
    expect(slave.playbackRate).toBe(1)
  })

  it('(i) [fix I5] a slave\'s corrective rate is preserved across a stall, and re-derives to the same value on recovery', () => {
    const { engine, master, slave } = mkMasterAndSlave()
    master.currentTime = 10
    slave.currentTime = 10 - 0.2 // behind - CATCHUP_RATE band

    engine.tick()
    expect(slave.playbackRate).toBe(CATCHUP_RATE)

    // A stall begins (unrelated to drift) - tick() pauses both before drift
    // correction runs this cycle, so the rate set above must survive untouched.
    slave.readyState = 1
    engine.tick()
    expect(slave.playbackRate).toBe(CATCHUP_RATE)
    expect(master.paused).toBe(true)

    // Recovery: elements resume, and because master/slave currentTime never
    // moved while paused, the SAME drift re-derives the SAME rate.
    slave.readyState = 4
    engine.tick()

    expect(slave.playbackRate).toBe(CATCHUP_RATE)
    expect(slave.currentTime).toBeLessThan(master.currentTime) // still behind
  })
})

describe('SyncEngine: play/pause/seek fan-out', () => {
  it('(a) play() fans out to every registered video', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)

    engine.play()

    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    expect(engine.playing).toBe(true)
  })

  it('(b) pause() fans out to every registered video', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    engine.pause()

    expect(master.paused).toBe(true)
    expect(slave.paused).toBe(true)
    expect(engine.playing).toBe(false)
  })

  it('(c) seek() fans out currentTime to every registered video', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    engine.seek(42)

    expect(master.currentTime).toBe(42)
    expect(slave.currentTime).toBe(42)
  })

  it('(d) seeking while paused updates every currentTime but leaves everything paused', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    // Never called engine.play() - engine starts paused.

    engine.seek(7)

    expect(master.currentTime).toBe(7)
    expect(slave.currentTime).toBe(7)
    expect(master.paused).toBe(true)
    expect(slave.paused).toBe(true)
    expect(engine.playing).toBe(false)
  })

  it('(e) [fix I5] seek() resets every playbackRate to 1 and keeps currentTime as the last-known value once the registry empties', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()
    master.currentTime = 10
    slave.currentTime = 10 - 0.2 // behind - would set CATCHUP_RATE
    engine.tick()
    expect(slave.playbackRate).toBe(CATCHUP_RATE)

    engine.seek(50)

    expect(master.currentTime).toBe(50)
    expect(slave.currentTime).toBe(50)
    expect(master.playbackRate).toBe(1)
    expect(slave.playbackRate).toBe(1) // stale correction reset by the seek
    expect(engine.currentTime).toBe(50)

    engine.unregister('master')
    expect(engine.currentTime).toBe(50) // last known, from the seek itself
  })
})

describe('SyncEngine: stall detection and recovery', () => {
  it('(a) any video with readyState < 3 while playing pauses everything and fires onStall(true)', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    slave.readyState = 1 // HAVE_METADATA - buffering

    engine.tick()

    expect(master.paused).toBe(true)
    expect(slave.paused).toBe(true)
    expect(onStall).toHaveBeenCalledWith(true)
    // Intent survives the stall: the engine was told to play and still means it.
    expect(engine.playing).toBe(true)
    assertStallInvariant(engine, [master, slave])
  })

  it('(b) once readyState recovers, tick() resumes playback and fires onStall(false)', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    slave.readyState = 1
    engine.tick()
    expect(master.paused).toBe(true)

    slave.readyState = 4
    engine.tick()

    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    expect(onStall).toHaveBeenCalledWith(false)
    expect(engine.playing).toBe(true)
  })

  it('(c) a video that was manually paused BEFORE the stall stays paused through the stall and its recovery', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    const sideStream = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.register('sideStream', sideStream, 2)
    engine.play()

    // Something outside the engine's play()/pause() fan-out paused this one
    // element specifically - e.g. the element itself, independent of intent.
    sideStream.pause()
    expect(sideStream.paused).toBe(true)

    // A different video stalls.
    slave.readyState = 1
    engine.tick()

    expect(master.paused).toBe(true)
    expect(slave.paused).toBe(true)
    expect(sideStream.paused).toBe(true) // already paused, unaffected either way
    expect(onStall).toHaveBeenCalledWith(true)
    assertStallInvariant(engine, [master, slave, sideStream])

    slave.readyState = 4
    engine.tick()

    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    // The engine's playing intent resumed master/slave (which IT paused for
    // the stall) but must not resume sideStream, which was never playing
    // when the stall began - the engine never paused it, so it owes it no
    // resume.
    expect(sideStream.paused).toBe(true)
    expect(onStall).toHaveBeenCalledWith(false)
  })

  it('(d) a video manually paused before the stall began stays paused even though engine.playing (intent) is true throughout', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()
    slave.pause() // manual pause of one element, intent is still "playing"

    expect(engine.playing).toBe(true)
    expect(slave.paused).toBe(true)

    master.readyState = 1
    engine.tick() // stall begins (master itself is the buffering one)
    master.readyState = 4
    engine.tick() // stall recovers

    expect(engine.playing).toBe(true)
    expect(master.paused).toBe(false) // engine paused+resumed this one for the stall
    expect(slave.paused).toBe(true) // was never part of the stall's pause/resume pair
  })

  it('(e) no stall is reported while the engine is not playing (intent is paused)', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    engine.register('master', master, 0)
    // engine never told to play; intent is paused.
    master.readyState = 1

    engine.tick()

    expect(onStall).not.toHaveBeenCalled()
    expect(engine.playing).toBe(false)
  })

  it('(f) [fix C2] pause() during an active stall clears it (fires onStall(false)) so a later play() actually plays, without waiting for another tick()', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)

    engine.play()
    slave.readyState = 1
    engine.tick() // stall begins
    expect(onStall.mock.calls).toEqual([[true]])
    expect(master.paused).toBe(true)

    engine.pause() // must not leave `stalled` wedged true forever
    expect(onStall.mock.calls).toEqual([[true], [false]])

    slave.readyState = 4 // recovers while paused - no tick() would ever see this transition
    engine.play()

    // No further onStall calls: this was never a second stall/recovery
    // cycle, just the ordinary pause -> play the caller asked for.
    expect(onStall.mock.calls).toEqual([[true], [false]])
    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    expect(engine.playing).toBe(true)
  })

  it('(g) [fix I3] a video registered WHILE the engine is playing (no stall) starts playing immediately, not on some future tick()', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    engine.register('master', master, 0)
    engine.play()

    const latecomer = new FakeVideo()
    engine.register('latecomer', latecomer, 1)

    expect(latecomer.paused).toBe(false)
  })

  it('(h) [fix I3] a video registered WHILE stalled is left paused during the stall, then resumed on recovery - not stuck forever', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    slave.readyState = 1
    engine.tick() // stall begins
    expect(onStall.mock.calls).toEqual([[true]])

    const newcomer = new FakeVideo()
    engine.register('newcomer', newcomer, 2)
    expect(newcomer.paused).toBe(true) // can't start it mid-stall

    slave.readyState = 4
    engine.tick() // stall clears

    expect(onStall.mock.calls).toEqual([[true], [false]])
    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    expect(newcomer.paused).toBe(false) // would previously stay paused forever
  })

  it('(i) [fix I5] onStall fires exactly once per edge, not once per tick() while the state persists', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    slave.readyState = 1
    engine.tick()
    engine.tick()
    engine.tick()
    expect(onStall.mock.calls).toEqual([[true]])

    slave.readyState = 4
    engine.tick()
    engine.tick()
    engine.tick()
    expect(onStall.mock.calls).toEqual([[true], [false]])
  })

  it('(j) [fix C2 round 2] play() on a fresh, still-buffering (never-played, paused) element reports a stall and actually resumes it on recovery', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const video = new FakeVideo()
    // Never played yet (paused stays at its default `true`), and not
    // buffered enough - the state a just-mounted <video> is commonly in.
    video.readyState = 2 // HAVE_CURRENT_DATA - below the HAVE_FUTURE_DATA=3 threshold
    engine.register('only', video, 0)

    engine.play()

    expect(onStall).toHaveBeenCalledWith(true)
    expect(engine.playing).toBe(true) // intent survives, same as any other stall

    video.readyState = 4
    engine.tick()

    // The regression this guards: onStall(false) firing while the element
    // was never actually told to play, because the stall check found nobody
    // to resume (it looked "already paused, not our concern" at the moment
    // it ran before the fan-out).
    expect(video.paused).toBe(false)
    expect(onStall).toHaveBeenCalledWith(false)
  })

  it('(k) [fix round 3] a redundant play() while genuinely still stalled re-pauses whatever it unpaused, with no duplicate onStall(true)', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    slave.readyState = 1
    engine.tick() // stall begins
    expect(onStall.mock.calls).toEqual([[true]])
    expect(master.paused).toBe(true)
    expect(slave.paused).toBe(true)
    assertStallInvariant(engine, [master, slave])

    // Redundant play() while STILL genuinely buffering (readyState never
    // recovered) - a UI double-click, or a StrictMode effect re-invoking.
    // Its fan-out unconditionally unpauses everything; reconciliation must
    // immediately re-pause and re-track both, with no second onStall(true).
    engine.play()

    expect(master.paused).toBe(true)
    expect(slave.paused).toBe(true)
    expect(onStall.mock.calls).toEqual([[true]]) // still just the one edge
    expect(engine.playing).toBe(true)
    assertStallInvariant(engine, [master, slave])

    // A second redundant play(), for good measure - still idempotent.
    engine.play()
    expect(onStall.mock.calls).toEqual([[true]])
    assertStallInvariant(engine, [master, slave])

    // Genuine recovery still works after all that: nothing was lost from
    // pausedForStall by the redundant calls.
    slave.readyState = 4
    engine.tick()

    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    expect(onStall.mock.calls).toEqual([[true], [false]])
  })
})

describe('electMaster: election rule and tie-break', () => {
  it('(a) picks the LOWEST preference, regardless of map order', () => {
    const elected = electMaster(
      new Map([
        ['screen', { preference: 2 }],
        ['presenter', { preference: 0 }],
        ['presentation', { preference: 1 }],
      ]),
    )
    expect(elected).toBe('presenter')
  })

  it('(b) breaks a preference tie by registration order: the earliest-registered candidate wins', () => {
    const elected = electMaster(
      new Map([
        ['first', { preference: 1 }],
        ['second', { preference: 1 }],
      ]),
    )
    expect(elected).toBe('first')
  })

  it('(c) returns null for an empty registry', () => {
    expect(electMaster(new Map())).toBeNull()
  })

  it('(d) negative and equal-to-zero preferences are ordered like any other number', () => {
    const elected = electMaster(
      new Map([
        ['zero', { preference: 0 }],
        ['negative', { preference: -1 }],
      ]),
    )
    expect(elected).toBe('negative')
  })

  it('(e) Infinity is just a very bad preference: a finite candidate beats it, either way round', () => {
    expect(
      electMaster(
        new Map([
          ['infinite', { preference: Number.POSITIVE_INFINITY }],
          ['finite', { preference: 99 }],
        ]),
      ),
    ).toBe('finite')
    expect(
      electMaster(
        new Map([
          ['finite', { preference: 99 }],
          ['infinite', { preference: Number.POSITIVE_INFINITY }],
        ]),
      ),
    ).toBe('finite')
  })

  it('(f) NaN sorts LAST: a comparable preference always beats it, whichever registered first', () => {
    expect(
      electMaster(
        new Map([
          ['broken', { preference: Number.NaN }],
          ['usable', { preference: 7 }],
        ]),
      ),
    ).toBe('usable')
    expect(
      electMaster(
        new Map([
          ['usable', { preference: 7 }],
          ['broken', { preference: Number.NaN }],
        ]),
      ),
    ).toBe('usable')
  })

  it('(g) a candidate is always elected when there is one at all - even if every preference is NaN', () => {
    // The engine's invariant is "non-empty registry => exactly one master".
    // An unusable preference must not be able to produce a masterless registry
    // with no audio at all; NaN ties fall back to registration order.
    expect(
      electMaster(
        new Map([
          ['first', { preference: Number.NaN }],
          ['second', { preference: Number.NaN }],
        ]),
      ),
    ).toBe('first')
    expect(electMaster(new Map([['lonely', { preference: Number.NaN }]]))).toBe('lonely')
  })
})

describe('SyncEngine: dynamic streams - master handover, rejoin, teardown', () => {
  /** presenter (master, pref 0), presentation (1), screen (2), engine playing. */
  function mkThree() {
    const onMasterChange = vi.fn()
    const onStall = vi.fn()
    const engine = new SyncEngine({ onMasterChange, onStall })
    const presenter = new FakeVideo()
    const presentation = new FakeVideo()
    const screen = new FakeVideo()
    engine.register('presenter', presenter, 0)
    engine.register('presentation', presentation, 1)
    engine.register('screen', screen, 2)
    engine.play()
    onMasterChange.mockClear() // the initial election is Task 6's contract, tested there
    return { engine, presenter, presentation, screen, onMasterChange, onStall }
  }

  it('(a) closing the master hands over to the next preference: event fired, audio moved, position continuous', () => {
    const { engine, presenter, presentation, screen, onMasterChange } = mkThree()

    // 30s of ordinary lock-step playback before the master goes away.
    for (let i = 0; i < 60; i++) {
      presenter.advance(0.5)
      presentation.advance(0.5)
      screen.advance(0.5)
      engine.tick()
    }
    const referenceTime = engine.currentTime
    expect(referenceTime).toBeCloseTo(30, 6)

    engine.unregister('presenter')

    expect(engine.masterId).toBe('presentation')
    expect(onMasterChange.mock.calls).toEqual([['presentation']]) // exactly one event, no null in between
    expect(presentation.muted).toBe(false)
    expect(screen.muted).toBe(true)
    expect(Math.abs(presentation.currentTime - referenceTime)).toBeLessThanOrEqual(0.05)
    // The CONSUMER's clock (what a scrubber/UI reads) is continuous too, not
    // just the underlying element - the getter now reads a different element
    // than it did a moment ago, which is exactly what must not be visible.
    expect(Math.abs(engine.currentTime - referenceTime)).toBeLessThanOrEqual(0.05)
    expect(presentation.paused).toBe(false) // the new clock is running
    assertAudioDiscipline(engine, { presentation, screen })
  })

  it('(b) the departing master is muted on the way out, so a lingering element cannot double up audio', () => {
    const { engine, presenter, presentation, screen } = mkThree()

    engine.unregister('presenter')

    expect(presenter.muted).toBe(true)
    assertAudioDiscipline(engine, { presentation, screen })
  })

  it(`(c) handover seeks the new master to the captured reference time when drift exceeds DRIFT_IGNORE_S = ${DRIFT_IGNORE_S}`, () => {
    const { engine, presenter, presentation } = mkThree()
    presenter.currentTime = 30
    presentation.currentTime = 29.4 // 0.6s behind - past the ignore band

    engine.unregister('presenter')

    expect(presentation.currentTime).toBe(30)
    expect(presentation.playbackRate).toBe(1)
  })

  it('(d) handover does NOT seek the new master when drift is inside the ignore band', () => {
    const { engine, presenter, presentation } = mkThree()
    presenter.currentTime = 30
    presentation.currentTime = 30 - 0.03
    const before = presentation.currentTime

    engine.unregister('presenter')

    expect(presentation.currentTime).toBe(before) // untouched: no needless seek
  })

  it(`(e) boundary: drift exactly at DRIFT_IGNORE_S = ${DRIFT_IGNORE_S} is still no seek (strictly greater only)`, () => {
    const { engine, presenter, presentation } = mkThree()
    // Single negation, not a float subtraction - see drift-band test (f).
    presenter.currentTime = DRIFT_IGNORE_S
    presentation.currentTime = 0

    engine.unregister('presenter')

    expect(presentation.currentTime).toBe(0)
  })

  it('(f) the promoted master carries the engine volume and drops any corrective playbackRate it had as a slave', () => {
    const { engine, presenter, presentation } = mkThree()
    engine.setVolume(0.4)
    presenter.currentTime = 10
    presentation.currentTime = 10 - 0.2 // behind -> CATCHUP_RATE
    engine.tick()
    expect(presentation.playbackRate).toBe(CATCHUP_RATE)

    // Nearly caught up again, so the handover does NOT seek - the promotion
    // itself is the only thing that can drop the stale corrective rate here.
    // Nothing else ever would: the master is never rate-corrected, so a
    // promoted slave would run the whole session 5% fast forever.
    presentation.currentTime = 10 - 0.02

    engine.unregister('presenter')

    expect(engine.masterId).toBe('presentation')
    expect(presentation.volume).toBe(0.4)
    expect(presentation.currentTime).toBe(10 - 0.02) // no seek: inside the ignore band
    expect(presentation.playbackRate).toBe(1)
  })

  it('(g) the new master is never drift-corrected afterwards; the remaining slave is corrected against it', () => {
    const { engine, presenter, presentation, screen } = mkThree()
    presenter.currentTime = 10
    presentation.currentTime = 10
    screen.currentTime = 10
    engine.unregister('presenter')
    expect(engine.masterId).toBe('presentation')

    screen.currentTime = 10 - 0.8 // far behind the NEW master
    engine.tick()

    expect(presentation.currentTime).toBe(10) // master untouched
    expect(presentation.playbackRate).toBe(1)
    expect(screen.currentTime).toBe(10) // slave hard-seeked to the new master's time
  })

  it('(h) preference ties in a handover are broken by registration order (earliest wins)', () => {
    const onMasterChange = vi.fn()
    const engine = new SyncEngine({ onMasterChange })
    const master = new FakeVideo()
    const early = new FakeVideo()
    const late = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('early', early, 1)
    engine.register('late', late, 1) // same preference, registered later
    onMasterChange.mockClear()

    engine.unregister('master')

    expect(engine.masterId).toBe('early')
    expect(onMasterChange.mock.calls).toEqual([['early']])
    assertAudioDiscipline(engine, { early, late })
  })

  it('(i) promotion resumes a stream that was paused independently: the master is the clock', () => {
    const { engine, presentation } = mkThree()
    presentation.pause() // something outside the engine paused just this stream

    engine.unregister('presenter')

    expect(engine.masterId).toBe('presentation')
    expect(presentation.paused).toBe(false) // a paused master would freeze the whole session
  })

  it('(j) a returning stream is seeked to master time BEFORE it participates, and rejoins muted', () => {
    const { engine, presenter, presentation, onMasterChange } = mkThree()

    engine.unregister('presentation')
    expect(engine.masterId).toBe('presenter') // unregistering a slave never re-elects
    expect(onMasterChange).not.toHaveBeenCalled()

    presenter.currentTime = 30 // master ran on for 30s while the stream was away
    presentation.currentTime = 0 // a fresh element (or one torn down and rebuilt)
    presentation.playbackRate = CATCHUP_RATE // a stale correction from its previous life

    engine.register('presentation', presentation, 1)

    expect(Math.abs(presentation.currentTime - 30)).toBeLessThanOrEqual(0.05)
    expect(presentation.playbackRate).toBe(1) // the align-seek clears the stale rate
    expect(presentation.muted).toBe(true)
    expect(presentation.paused).toBe(false) // intent is playing, so it joins playing
    expect(engine.masterId).toBe('presenter')
    expect(onMasterChange).not.toHaveBeenCalled() // rejoining a slave changes nothing
  })

  it('(k) a returning stream with a BETTER preference takes over as master at the old master time', () => {
    const onMasterChange = vi.fn()
    const engine = new SyncEngine({ onMasterChange })
    const screen = new FakeVideo()
    engine.register('screen', screen, 2)
    engine.play()
    screen.currentTime = 30
    onMasterChange.mockClear()

    const presenter = new FakeVideo() // pref 0, arrives late, currentTime 0
    engine.register('presenter', presenter, 0)

    expect(engine.masterId).toBe('presenter')
    expect(onMasterChange.mock.calls).toEqual([['presenter']])
    expect(presenter.currentTime).toBe(30) // continuity: no jump back to 0
    assertAudioDiscipline(engine, { screen, presenter })
  })

  it('(l) unregistering the LAST stream nulls the master but preserves currentTime for a later resume', () => {
    const { engine, presenter, presentation, screen, onMasterChange } = mkThree()
    engine.unregister('screen')
    engine.unregister('presentation')
    presenter.currentTime = 42
    onMasterChange.mockClear()

    engine.unregister('presenter')

    expect(engine.masterId).toBeNull()
    expect(onMasterChange.mock.calls).toEqual([[null]])
    expect(engine.currentTime).toBe(42)
    expect(presenter.muted).toBe(true)
    expect(presentation.muted).toBe(true)
    expect(screen.muted).toBe(true)

    // Much later, a stream comes back: it resumes at the preserved position.
    const fresh = new FakeVideo()
    engine.register('presenter', fresh, 0)

    expect(engine.masterId).toBe('presenter')
    expect(onMasterChange.mock.calls).toEqual([[null], ['presenter']])
    expect(fresh.currentTime).toBe(42)
    expect(fresh.muted).toBe(false)
    assertAudioDiscipline(engine, { presenter: fresh })
  })

  it('(m) the FIRST registration on a fresh engine keeps the element position: there is nothing to resume to', () => {
    const engine = new SyncEngine()
    const video = new FakeVideo()
    video.currentTime = 12 // e.g. the app pre-positioned the element

    engine.register('only', video, 0)

    expect(video.currentTime).toBe(12)
    expect(engine.currentTime).toBe(12)
  })

  it('(n) unregistering an unknown id is a no-op and never throws', () => {
    const { engine, presenter, presentation, screen, onMasterChange, onStall } = mkThree()

    expect(() => engine.unregister('does-not-exist')).not.toThrow()

    expect(engine.masterId).toBe('presenter')
    expect(onMasterChange).not.toHaveBeenCalled()
    expect(onStall).not.toHaveBeenCalled()
    expect(presenter.muted).toBe(false)
    expect(presenter.paused).toBe(false)
    assertAudioDiscipline(engine, { presenter, presentation, screen })

    // Also fine on a completely empty engine, twice over.
    const empty = new SyncEngine()
    expect(() => empty.unregister('ghost')).not.toThrow()
    expect(() => empty.unregister('ghost')).not.toThrow()
    expect(empty.masterId).toBeNull()
  })

  it('(o) stalled handover, the DEPARTING master was the buffering one: removal resolves the stall', () => {
    const { engine, presenter, presentation, screen, onStall } = mkThree()
    presenter.readyState = 1 // the master itself is buffering
    engine.tick()
    expect(onStall.mock.calls).toEqual([[true]])
    assertStallInvariant(engine, [presenter, presentation, screen])

    engine.unregister('presenter')

    expect(engine.masterId).toBe('presentation')
    expect(presentation.muted).toBe(false)
    expect(presentation.paused).toBe(false) // nothing is buffering any more
    expect(screen.paused).toBe(false)
    expect(onStall.mock.calls).toEqual([[true], [false]])
    expect(engine.playing).toBe(true)
    assertStallInvariant(engine, [presentation, screen])
    assertAudioDiscipline(engine, { presentation, screen })
  })

  it('(p) stalled handover, a REMAINING stream is buffering: the new master is promoted but stays paused', () => {
    const { engine, presenter, presentation, screen, onStall } = mkThree()
    screen.readyState = 1 // a stream that stays registered is the buffering one
    engine.tick()
    expect(onStall.mock.calls).toEqual([[true]])

    engine.unregister('presenter')

    expect(engine.masterId).toBe('presentation')
    expect(presentation.muted).toBe(false) // audio moves immediately
    expect(presentation.paused).toBe(true) // but the stall still holds everything
    expect(onStall.mock.calls).toEqual([[true]]) // no spurious exit edge
    assertStallInvariant(engine, [presentation, screen])
    assertAudioDiscipline(engine, { presentation, screen })

    screen.readyState = 4
    engine.tick()

    expect(presentation.paused).toBe(false) // the promoted master is resumed, not stranded
    expect(screen.paused).toBe(false)
    expect(onStall.mock.calls).toEqual([[true], [false]])
    assertAudioDiscipline(engine, { presentation, screen })
  })

  it('(q) audio discipline and the "non-empty registry has a master" invariant hold across a full teardown chain', () => {
    const { engine, presenter, presentation, screen, onMasterChange } = mkThree()
    assertAudioDiscipline(engine, { presenter, presentation, screen })

    engine.unregister('presenter')
    expect(engine.masterId).toBe('presentation')
    expect(onMasterChange.mock.calls).toEqual([['presentation']])
    assertAudioDiscipline(engine, { presentation, screen })

    // The SECOND handover in a row: one event, the successor's id, still no
    // intermediate null - the per-step call list is asserted cumulatively so a
    // stray extra event anywhere in the chain shows up.
    engine.unregister('presentation')
    expect(engine.masterId).toBe('screen')
    expect(onMasterChange.mock.calls).toEqual([['presentation'], ['screen']])
    assertAudioDiscipline(engine, { screen })

    // Only the step that actually empties the registry reports null.
    engine.unregister('screen')
    expect(engine.masterId).toBeNull()
    expect(onMasterChange.mock.calls).toEqual([['presentation'], ['screen'], [null]])
    assertAudioDiscipline(engine, {})
  })

  it('(r) handover while the engine intent is PAUSED promotes without starting anything', () => {
    const onMasterChange = vi.fn()
    const engine = new SyncEngine({ onMasterChange })
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()
    master.currentTime = 20
    slave.currentTime = 20
    engine.pause()
    onMasterChange.mockClear()

    engine.unregister('master')

    expect(engine.masterId).toBe('slave')
    expect(onMasterChange.mock.calls).toEqual([['slave']])
    expect(slave.muted).toBe(false)
    expect(slave.paused).toBe(true) // intent is paused: promotion must not start playback
    expect(engine.playing).toBe(false)
    expect(engine.currentTime).toBe(20)
  })

  it('(s) handover into a successor that is itself under-buffered enters a stall instead of running it dry', () => {
    const { engine, presentation, screen, onStall } = mkThree()
    presentation.readyState = 1 // the successor-to-be is the buffering one
    expect(onStall).not.toHaveBeenCalled() // no tick() yet, so no stall is active

    engine.unregister('presenter')

    expect(engine.masterId).toBe('presentation')
    expect(presentation.muted).toBe(false)
    expect(onStall.mock.calls).toEqual([[true]]) // promotion itself surfaced the stall
    assertStallInvariant(engine, [presentation, screen])

    presentation.readyState = 4
    engine.tick()

    expect(presentation.paused).toBe(false)
    expect(screen.paused).toBe(false)
    expect(onStall.mock.calls).toEqual([[true], [false]])
  })
})

describe('SyncEngine: [review round 5] single-site audio discipline and hostile preferences', () => {
  /**
   * The strongest form of the audio invariant: across EVERY element the test
   * has ever handed the engine - still registered, unregistered, or displaced
   * by a swap - exactly one is unmuted, and it is the master's current
   * element. Departed elements are included on purpose: that's the leftover
   * double-audio hazard this round is about.
   */
  function expectSingleAudioSource(all: FakeVideo[], master: FakeVideo | null): void {
    expect(all.filter((v) => !v.muted)).toEqual(master === null ? [] : [master])
  }

  it('(a) [I1] swapping the master ELEMENT under a stable id silences AND stops the displaced element', () => {
    const onMasterChange = vi.fn()
    const engine = new SyncEngine({ onMasterChange })
    const first = new FakeVideo()
    const presentation = new FakeVideo()
    const screen = new FakeVideo()
    engine.register('master', first, 0)
    engine.register('presentation', presentation, 1)
    engine.register('screen', screen, 2)
    engine.play()
    first.currentTime = 30
    presentation.currentTime = 30
    screen.currentTime = 30
    expect(first.muted).toBe(false)
    expect(first.paused).toBe(false)
    onMasterChange.mockClear()

    // A React element swap under the SAME id, with no unregister in between -
    // a supported path (see registration test (h)).
    const second = new FakeVideo()
    engine.register('master', second, 0)

    expect(engine.masterId).toBe('master')
    expect(second.muted).toBe(false) // the incoming element carries the audio
    expect(first.muted).toBe(true) // ...and the outgoing one must not, too
    expect(first.paused).toBe(true) // nor keep decoding a stream nobody watches
    expectSingleAudioSource([first, second, presentation, screen], second)
    expect(second.currentTime).toBe(30) // still aligned to the session clock
    expect(onMasterChange).not.toHaveBeenCalled() // same id, same role: nothing changed
  })

  it('(b) [I1] swapping a SLAVE element under a stable id also stops the displaced element', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const first = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', first, 1)
    engine.play()
    expect(first.paused).toBe(false)

    const second = new FakeVideo()
    engine.register('slave', second, 1)

    expect(first.paused).toBe(true)
    expect(first.muted).toBe(true)
    expectSingleAudioSource([master, first, second], master)
  })

  it('(c) unregistering silences AND stops the departing element, master or slave', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()

    engine.unregister('slave')
    expect(slave.paused).toBe(true)
    expect(slave.muted).toBe(true)

    engine.unregister('master')
    expect(master.paused).toBe(true)
    expect(master.muted).toBe(true)
    expectSingleAudioSource([master, slave], null)
  })

  it('(c2) re-registering the SAME element is not a swap: it is never retired, so nothing churns', () => {
    const engine = new SyncEngine()
    const master = new FakeVideo()
    const slave = new FakeVideo()
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)
    engine.play()
    const masterPauses = master.pauseCalls
    const slavePauses = slave.pauseCalls

    // A ref re-firing / StrictMode double-invoke: same id, SAME object.
    engine.register('master', master, 0)
    engine.register('slave', slave, 1)

    // Treating this as a swap would pause each element and then immediately
    // play it again - on a real <video>, a pause/play event pair and a decode
    // interruption per re-render, for no reason at all.
    expect(master.pauseCalls).toBe(masterPauses)
    expect(slave.pauseCalls).toBe(slavePauses)
    expect(master.paused).toBe(false)
    expect(slave.paused).toBe(false)
    expectSingleAudioSource([master, slave], master)
  })

  it('(d) [I2] the audio sweep re-derives from current state: repeated registrations never drift out of discipline', () => {
    const engine = new SyncEngine()
    const presenter = new FakeVideo()
    const presentation = new FakeVideo()
    const screen = new FakeVideo()
    engine.register('presenter', presenter, 0)
    engine.register('presentation', presentation, 1)
    engine.register('screen', screen, 2)

    // Hammer the registry with re-registrations, in an order that keeps
    // changing which entry was touched last.
    for (let i = 0; i < 3; i++) {
      engine.register('screen', screen, 2)
      engine.register('presenter', presenter, 0)
      engine.register('presentation', presentation, 1)
      expectSingleAudioSource([presenter, presentation, screen], presenter)
    }

    // Something outside the engine mutes the master (a stray element write, a
    // browser autoplay policy). The next registry mutation sweeps it back.
    presenter.muted = true
    engine.register('screen', screen, 2)
    expectSingleAudioSource([presenter, presentation, screen], presenter)
  })

  it('(e) [I2 minor] re-registering the master with a WORSE preference hands over immediately', () => {
    const onMasterChange = vi.fn()
    const engine = new SyncEngine({ onMasterChange })
    const presenter = new FakeVideo()
    const presentation = new FakeVideo()
    engine.register('presenter', presenter, 0)
    engine.register('presentation', presentation, 1)
    engine.play()
    presenter.currentTime = 30
    presentation.currentTime = 30
    onMasterChange.mockClear()

    // The same id comes back deprioritized (a layout change, a stream that
    // lost its audio track). The election must run NOW, not be deferred to
    // whatever unrelated call happens to mutate the registry next.
    engine.register('presenter', presenter, 5)

    expect(engine.masterId).toBe('presentation')
    expect(onMasterChange.mock.calls).toEqual([['presentation']])
    expectSingleAudioSource([presenter, presentation], presentation)
    expect(Math.abs(presentation.currentTime - 30)).toBeLessThanOrEqual(0.05)
  })

  it('(f) [I2 minor] a NaN preference never produces a masterless, silent registry', () => {
    const engine = new SyncEngine()
    const broken = new FakeVideo()
    // A caller passing through a bad computation (parseInt of a missing
    // flavor, an undefined index) must not be able to silence the session.
    engine.register('broken', broken, Number.NaN)

    expect(engine.masterId).toBe('broken')
    expectSingleAudioSource([broken], broken)

    // A usable preference arriving later takes over, since NaN sorts last.
    const usable = new FakeVideo()
    engine.register('usable', usable, 3)

    expect(engine.masterId).toBe('usable')
    expectSingleAudioSource([broken, usable], usable)
  })

  it('(g) [I2 minor] a NaN preference never displaces a usable master, and never wins a handover from one', () => {
    const engine = new SyncEngine()
    const presenter = new FakeVideo()
    const broken = new FakeVideo()
    const screen = new FakeVideo()
    engine.register('presenter', presenter, 0)
    engine.register('broken', broken, Number.NaN)
    engine.register('screen', screen, 2)
    expect(engine.masterId).toBe('presenter')

    engine.unregister('presenter')

    expect(engine.masterId).toBe('screen') // the comparable preference wins
    expectSingleAudioSource([presenter, broken, screen], screen)
  })

  it('(h) [P3] emptying the registry while stalled ends the stall instead of wedging it', () => {
    const onStall = vi.fn()
    const engine = new SyncEngine({ onStall })
    const master = new FakeVideo()
    engine.register('master', master, 0)
    engine.play()
    master.currentTime = 12
    master.readyState = 1
    engine.tick()
    expect(onStall.mock.calls).toEqual([[true]])

    engine.unregister('master') // the only stream, and it's the buffering one

    expect(engine.masterId).toBeNull()
    expect(onStall.mock.calls).toEqual([[true], [false]]) // nothing left to buffer
    expect(engine.playing).toBe(true) // intent is untouched by a teardown
    expect(engine.currentTime).toBe(12)

    // And the engine is not wedged: a stream registering later plays.
    const rejoin = new FakeVideo()
    engine.register('master', rejoin, 0)
    expect(rejoin.currentTime).toBe(12)
    expect(rejoin.paused).toBe(false)
    expect(onStall.mock.calls).toEqual([[true], [false]])
  })

  it('(i) onMasterChange fires AFTER the audio sweep: a consumer reading elements in the callback sees the finished state', () => {
    const seen: Array<{ id: string | null; unmuted: string[] }> = []
    const videos: Record<string, FakeVideo> = {}
    const engine = new SyncEngine({
      onMasterChange: (id) =>
        seen.push({
          id,
          unmuted: Object.entries(videos)
            .filter(([, v]) => !v.muted)
            .map(([k]) => k),
        }),
    })
    // Each element enters the record only as it's registered, so the snapshot
    // above never reports an element the engine hasn't been given yet.
    videos.presenter = new FakeVideo()
    engine.register('presenter', videos.presenter, 0)
    videos.presentation = new FakeVideo()
    engine.register('presentation', videos.presentation, 1)
    engine.play()

    engine.unregister('presenter')

    // Both events: at the moment the consumer is told who the master is, the
    // mute/volume arrangement must already match that answer.
    expect(seen).toEqual([
      { id: 'presenter', unmuted: ['presenter'] },
      { id: 'presentation', unmuted: ['presentation'] },
    ])
  })

  it('(j) [minor] a recording swap is seek(0) on the emptied engine, not a stale-position rejoin', () => {
    const engine = new SyncEngine()
    const oldRecording = new FakeVideo()
    engine.register('presenter', oldRecording, 0)
    engine.play()
    oldRecording.currentTime = 90
    engine.unregister('presenter') // last stream of the old recording

    // Without the seek, the next recording's first stream would resume at the
    // previous recording's position (the documented behavior of a preserved
    // reference) - which is right for a rejoin and wrong for a new recording.
    engine.seek(0)

    const newRecording = new FakeVideo()
    engine.register('presenter', newRecording, 0)

    expect(newRecording.currentTime).toBe(0)
    expect(engine.currentTime).toBe(0)
  })
})
