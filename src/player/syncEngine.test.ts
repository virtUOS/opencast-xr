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
})
