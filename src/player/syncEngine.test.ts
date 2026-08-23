import { describe, expect, it, vi } from 'vitest'
import type { VideoLike } from './videoLike'
import { CATCHUP_RATE, DRIFT_IGNORE_S, DRIFT_SEEK_S, SLOWDOWN_RATE, SyncEngine } from './syncEngine'

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

  play(): void {
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  advance(dt: number): void {
    if (!this.paused) this.currentTime += dt * this.playbackRate
  }
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
})
