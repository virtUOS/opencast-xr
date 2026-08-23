import type { VideoLike } from './videoLike'

export interface EngineEvents {
  onMasterChange?: (id: string | null) => void
  onStall?: (stalled: boolean) => void
}

/** Drift within this band is considered "in sync" - playbackRate snaps back to 1. */
export const DRIFT_IGNORE_S = 0.05
/** Drift at or beyond this is corrected by a hard seek instead of a rate nudge. */
export const DRIFT_SEEK_S = 0.5
/** Applied to a slave that's behind the master, to close the gap. */
export const CATCHUP_RATE = 1.05
/** Applied to a slave that's ahead of the master, to let the master catch up. */
export const SLOWDOWN_RATE = 0.95

interface RegisteredVideo {
  video: VideoLike
  preference: number
}

/** Fires `video.play()` without letting a rejected returned promise become an unhandled rejection. */
function safePlay(video: VideoLike): void {
  const result = video.play()
  if (result && typeof result.catch === 'function') {
    result.catch(() => {})
  }
}

/**
 * Pure state machine that keeps N Opencast video streams in lip-sync. Sees
 * videos only through VideoLike - no DOM, no timers, no React. `tick()` is
 * driven from the outside (rAF/interval) so every timing scenario is
 * testable with a fake clock.
 *
 * The MASTER is the clock: it carries audio (unmuted) and is never
 * rate/seek-corrected. Every slave is muted and gets drift-corrected against
 * the master's currentTime. `playing` is the engine's INTENT, kept distinct
 * from any single video's element state - a stall pauses elements without
 * changing intent, so recovery resumes exactly what the stall itself paused.
 *
 * Registration here only elects a master when a strictly better-preference
 * (lower number) candidate joins; it never re-elects on unregister. Dynamic
 * handover when the master leaves is Task 7's job (YAGNI here on purpose).
 */
export class SyncEngine {
  private readonly events: EngineEvents
  private readonly entries = new Map<string, RegisteredVideo>()
  private currentMasterId: string | null = null
  private intentPlaying = false
  private stalled = false
  /** Ids the engine itself paused to enforce a stall, so it knows exactly who to resume on recovery. */
  private readonly pausedForStall = new Set<string>()
  private masterVolume = 1
  private lastKnownTime = 0

  constructor(events: EngineEvents = {}) {
    this.events = events
  }

  register(id: string, video: VideoLike, preference: number): void {
    this.entries.set(id, { video, preference })

    const currentMaster = this.currentMasterId ? this.entries.get(this.currentMasterId) : undefined
    if (!currentMaster || preference < currentMaster.preference) {
      this.promoteToMaster(id)
    } else {
      video.muted = true
    }
  }

  unregister(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return

    this.entries.delete(id)
    this.pausedForStall.delete(id)

    if (this.currentMasterId === id) {
      this.lastKnownTime = entry.video.currentTime
      this.currentMasterId = null
      this.events.onMasterChange?.(null)
    }
  }

  get masterId(): string | null {
    return this.currentMasterId
  }

  get currentTime(): number {
    const master = this.currentMasterId ? this.entries.get(this.currentMasterId) : undefined
    if (master) {
      this.lastKnownTime = master.video.currentTime
      return master.video.currentTime
    }
    return this.lastKnownTime
  }

  get playing(): boolean {
    return this.intentPlaying
  }

  play(): void {
    this.intentPlaying = true
    if (this.stalled) return // hold - the stall's own recovery path will resume what it paused
    for (const { video } of this.entries.values()) safePlay(video)
  }

  pause(): void {
    this.intentPlaying = false
    for (const { video } of this.entries.values()) video.pause()
  }

  seek(seconds: number): void {
    for (const { video } of this.entries.values()) video.currentTime = seconds
  }

  setVolume(v: number): void {
    this.masterVolume = v
    const master = this.currentMasterId ? this.entries.get(this.currentMasterId) : undefined
    if (master) master.video.volume = v
  }

  tick(): void {
    this.detectStall()
    if (this.stalled || !this.intentPlaying) return
    if (!this.currentMasterId) return

    const master = this.entries.get(this.currentMasterId)
    if (!master) return
    const masterTime = master.video.currentTime

    for (const [id, entry] of this.entries) {
      if (id === this.currentMasterId) continue
      this.correctDrift(entry.video, masterTime)
    }
  }

  private promoteToMaster(id: string): void {
    const previousId = this.currentMasterId
    if (previousId !== null && previousId !== id) {
      const previous = this.entries.get(previousId)
      if (previous) previous.video.muted = true
    }

    this.currentMasterId = id
    const entry = this.entries.get(id)
    if (entry) {
      entry.video.muted = false
      entry.video.volume = this.masterVolume
    }
    this.events.onMasterChange?.(id)
  }

  private correctDrift(video: VideoLike, masterTime: number): void {
    const drift = video.currentTime - masterTime // negative: behind, positive: ahead
    const absDrift = Math.abs(drift)

    if (absDrift >= DRIFT_SEEK_S) {
      video.currentTime = masterTime
      video.playbackRate = 1
      return
    }

    if (absDrift <= DRIFT_IGNORE_S) {
      video.playbackRate = 1
      return
    }

    video.playbackRate = drift < 0 ? CATCHUP_RATE : SLOWDOWN_RATE
  }

  private detectStall(): void {
    if (!this.intentPlaying) return

    const isBuffering = [...this.entries.values()].some((e) => e.video.readyState < 3)

    if (isBuffering && !this.stalled) {
      this.enterStall()
    } else if (!isBuffering && this.stalled) {
      this.exitStall()
    }
  }

  private enterStall(): void {
    this.stalled = true
    this.pausedForStall.clear()
    for (const [id, entry] of this.entries) {
      if (!entry.video.paused) {
        entry.video.pause()
        this.pausedForStall.add(id)
      }
    }
    this.events.onStall?.(true)
  }

  private exitStall(): void {
    this.stalled = false
    for (const [id, entry] of this.entries) {
      if (this.pausedForStall.has(id)) safePlay(entry.video)
    }
    this.pausedForStall.clear()
    this.events.onStall?.(false)
  }
}
