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
    // Capture the previous master's id/entry BEFORE mutating the map: if
    // `id` re-registers the CURRENT master (a React ref re-firing, a
    // StrictMode double-invoke, or an element swap under a stable id),
    // `entries.set` below would otherwise overwrite the entry first and
    // make the master compare itself against itself, landing in the
    // else-branch and muting the only unmuted (audio-carrying) video.
    const previousMasterId = this.currentMasterId
    const currentMaster = previousMasterId ? this.entries.get(previousMasterId) : undefined
    const reRegisteringMaster = id === previousMasterId

    this.entries.set(id, { video, preference })

    if (reRegisteringMaster) {
      // Same id, still master: stay unmuted at the master volume. No
      // election re-run and no onMasterChange re-fire - nothing changed.
      video.muted = false
      video.volume = this.masterVolume
    } else if (!currentMaster || preference < currentMaster.preference) {
      this.promoteToMaster(id)
    } else {
      video.muted = true
    }

    this.reconcileToIntent(video)
  }

  /**
   * Brings a just-(re)registered video's element state in line with the
   * engine's current intent, so a newcomer joining mid-playback doesn't sit
   * paused forever waiting for the next explicit play()/tick(). Plays it
   * unconditionally (if intent is playing) and lets reconcileStall() sort
   * out whether that has to be walked straight back - e.g. the newcomer
   * itself is under-buffered, or a stall is already active for an unrelated
   * reason - exactly like it would for any other video.
   */
  private reconcileToIntent(video: VideoLike): void {
    if (!this.intentPlaying) return
    safePlay(video)
    this.reconcileStall()
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

    // Removing the buffering video can itself resolve a stall.
    this.reconcileStall()
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
    // Unconditional fan-out FIRST, reconcileStall() AFTER - order matters.
    // safePlay() flips each video's `paused` to false synchronously (real
    // <video> elements do this too: play() sets paused=false immediately,
    // independent of whether enough data has buffered yet). reconcileStall()
    // decides who it owes a resume by looking at who's currently unpaused -
    // so running it first (an earlier version of this fix) meant a
    // still-buffering element that had never been played yet (paused===true
    // from a fresh registration, or from a prior pause()) looked exactly
    // like a video the caller genuinely wants paused: it was never tracked
    // for resume, and recovery's onStall(false) would fire with that
    // element still stopped forever.
    //
    // This also covers a REDUNDANT play() while a stall is already active
    // (a double-click, a StrictMode re-invoke): the fan-out below
    // unconditionally unpauses everything, including whatever the stall had
    // paused - but reconcileStall() runs on every path through here, so it
    // immediately re-pauses and re-tracks anything still genuinely
    // buffering, rather than leaving the engine claiming "stalled" while
    // elements actually play. reconcileStall() is idempotent (see its own
    // comment), so this is safe to call unconditionally on every play().
    for (const { video } of this.entries.values()) safePlay(video)
    this.reconcileStall()
  }

  pause(): void {
    this.intentPlaying = false
    // Pausing ends any active stall too: "stalled" only means anything while
    // the engine intends to play. Otherwise a stall entered while playing,
    // followed by pause(), would wedge `stalled` true forever - reconcileStall()
    // early-returns on !intentPlaying, so nothing would ever fire the exit
    // edge or clear it, and a later play() would then see `stalled` still
    // true and refuse to start anything.
    if (this.stalled) {
      this.stalled = false
      this.events.onStall?.(false)
    }
    this.pausedForStall.clear()
    for (const { video } of this.entries.values()) video.pause()
  }

  seek(seconds: number): void {
    for (const { video } of this.entries.values()) {
      video.currentTime = seconds
      // A hard seek makes any accumulated catchup/slowdown correction stale
      // - everything is exactly at masterTime immediately after, so drift
      // is zero and the rate belongs back at 1.
      video.playbackRate = 1
    }
    // Keep the "last known" value current even with no master registered
    // (or once it later becomes empty), matching the currentTime getter's
    // fallback contract.
    this.lastKnownTime = seconds
  }

  setVolume(v: number): void {
    this.masterVolume = v
    const master = this.currentMasterId ? this.entries.get(this.currentMasterId) : undefined
    if (master) master.video.volume = v
  }

  tick(): void {
    this.reconcileStall()
    if (this.stalled || !this.intentPlaying) return
    if (!this.currentMasterId) return

    const master = this.entries.get(this.currentMasterId)
    if (!master) return
    const masterTime = master.video.currentTime

    for (const [id, entry] of this.entries) {
      if (id === this.currentMasterId) continue
      // A slave paused independently of engine intent (e.g. the user
      // paused just that stream) is idle, not lagging: correcting it would
      // hard-seek it over and over as the playing master pulls away, purely
      // to keep an element nobody's watching "in sync" - wasted seeks/range
      // requests on a real <video>. Once it's resumed (paused flips back to
      // false, however that happens), the very next tick applies the normal
      // bands to it - typically a hard seek, since drift has usually grown
      // past DRIFT_SEEK_S while it sat paused.
      if (entry.video.paused) continue
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

  /**
   * Enforces the stall invariant IDEMPOTENTLY: safe to call after every
   * public method that could have changed either buffering or an element's
   * paused state, not just once per genuine edge transition. That's what
   * closes the family of "a redundant call unpauses something and nobody
   * notices" bugs (a second play() while already stalled, a newcomer
   * registered mid-stall, ...): every call re-derives the invariant from
   * CURRENT state rather than trusting that nothing changed since the last
   * check.
   *
   * - While playing and anything is under-buffered: every video that's
   *   currently NOT paused gets paused right now and added to
   *   pausedForStall, so it's owed a resume once buffering clears. This
   *   runs on EVERY call while buffering persists, not only on the
   *   false -> true transition - onStall(true) itself still only fires on
   *   that transition, so callers never see a duplicate.
   * - Once nothing is buffering and a stall was active: resumes exactly the
   *   videos this mechanism paused (pausedForStall), never anything a
   *   caller paused independently of intent, and fires onStall(false).
   */
  private reconcileStall(): void {
    if (!this.intentPlaying) return

    const isBuffering = [...this.entries.values()].some((e) => e.video.readyState < 3)

    if (isBuffering) {
      const wasStalled = this.stalled
      this.stalled = true
      for (const [id, entry] of this.entries) {
        if (!entry.video.paused) {
          entry.video.pause()
          this.pausedForStall.add(id)
        }
      }
      if (!wasStalled) this.events.onStall?.(true)
      return
    }

    if (this.stalled) {
      this.stalled = false
      for (const [id, entry] of this.entries) {
        if (this.pausedForStall.has(id)) safePlay(entry.video)
      }
      this.pausedForStall.clear()
      this.events.onStall?.(false)
    }
  }
}
