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

/**
 * Is `candidate` a better master than the incumbent best? Lower preference
 * wins; equal never displaces (that's the registration-order tie-break).
 *
 * NaN sorts LAST rather than poisoning the comparison: `NaN < x` and
 * `x < NaN` are both false, so a naive `<` would let an unusable preference
 * that happened to be seen first block every comparable candidate behind it.
 * A stream whose preference is NaN is a last resort - electable, because the
 * engine's "non-empty registry has a master" invariant matters more than the
 * caller's arithmetic mistake, but never in front of a usable one.
 */
function beatsIncumbent(candidate: number, incumbent: number): boolean {
  if (Number.isNaN(incumbent)) return !Number.isNaN(candidate)
  return candidate < incumbent
}

/**
 * The election rule, in one place: the LOWEST preference number wins, and a
 * non-empty candidate set ALWAYS elects someone (only an empty one yields
 * null) - that's what keeps a populated registry from ending up masterless
 * and therefore silent.
 *
 * TIE-BREAK: a preference tie is broken by REGISTRATION ORDER - the
 * earliest-registered candidate wins - which falls out of `Map`'s
 * insertion-order iteration plus `beatsIncumbent`'s strict comparison (a later
 * candidate with an equal preference never displaces the incumbent best). Note
 * that re-registering an existing id keeps its ORIGINAL insertion position
 * (that's `Map.set` semantics), so "registration order" means when the id was
 * first seen, not when it was last refreshed - which is what makes an element
 * swap under a stable id election-neutral.
 *
 * Deliberately a free function over a structural `{ preference }` map rather
 * than a method: election is pure, so it's unit-testable on its own, and
 * every election in the engine (register and unregister alike) goes through
 * this one rule instead of re-deriving it.
 */
export function electMaster(
  candidates: ReadonlyMap<string, { readonly preference: number }>,
): string | null {
  let bestId: string | null = null
  let bestPreference = Number.NaN
  for (const [id, { preference }] of candidates) {
    // `bestId === null` first: the seed is "nobody yet", not "preference
    // Infinity" - seeding with a sentinel number is what made NaN (and, for
    // a naive seed, Infinity itself) electable-or-not by accident.
    if (bestId === null || beatsIncumbent(preference, bestPreference)) {
      bestId = id
      bestPreference = preference
    }
  }
  return bestId
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
 * The registry is DYNAMIC: streams come and go mid-session. Every mutation
 * (register or unregister) re-runs the same election (`electMaster`) and then
 * the same audio sweep (`applyAudio`), so two invariants hold after every
 * public call:
 *   1. a non-empty registry has exactly one master - the lowest-preference
 *      stream registered - so there is no masterless-but-populated state, not
 *      even for a hostile preference like NaN;
 *   2. exactly one REGISTERED stream is unmuted, and it's that master. An
 *      element that leaves engine control (unregistered, or displaced by a
 *      swap under a stable id) is `retire()`d - silenced and stopped - since
 *      the sweep can no longer reach it.
 * A handover captures the departing master's position FIRST and hands it to
 * the successor as the reference time, so the session's clock survives its
 * clock-carrier leaving.
 *
 * SWITCHING RECORDINGS: the engine preserves the session position across an
 * empty registry on purpose (a stream that unmounts and remounts must resume,
 * not restart). So when the consumer moves to a DIFFERENT recording, it has to
 * say so - call `seek(0)` on the emptied engine before registering the new
 * recording's streams, or the first of them will resume at the previous
 * recording's position. (Constructing a fresh SyncEngine works too, but a
 * seek is the smaller, more obvious move and keeps any event wiring intact.)
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
  /**
   * True once `lastKnownTime` carries a real session position - a seek, or the
   * position a departing master left behind - as opposed to its initial 0.
   * This is what separates "resume the session at 0" (a stream rejoining after
   * everything was torn down at 0) from "no opinion yet" (the very first
   * registration on a fresh engine, whose element position is left alone).
   */
  private hasReference = false

  constructor(events: EngineEvents = {}) {
    this.events = events
  }

  register(id: string, video: VideoLike, preference: number): void {
    // Capture the displaced element AND the session position BEFORE mutating
    // the map. Both matter:
    //  - `id` may already hold a DIFFERENT element (a React element swap under
    //    a stable id, an <video> node replaced on remount). `entries.set`
    //    below drops the engine's only handle on it, so if it isn't retired
    //    here it keeps playing - unmuted, if it was the master - as a second
    //    audio source nobody can reach any more.
    //  - The reference time has to come from the OUTGOING element (or from
    //    lastKnownTime when nothing is registered), because after `set` the
    //    map may point at a brand-new element sitting at 0.
    const displaced = this.entries.get(id)?.video
    const reference = this.referenceTime()

    this.entries.set(id, { video, preference })

    // Same object re-registered (a ref re-firing, a StrictMode double-invoke)
    // is NOT a swap: retiring it would silence and stop the very element being
    // registered.
    if (displaced && displaced !== video) this.retire(displaced)

    // One election rule for every registry mutation, run NOW rather than
    // deferred to some later call: the newcomer wins only by being strictly
    // better than the incumbent (electMaster's tie-break keeps the
    // earlier-registered one), an id coming back with a WORSE preference hands
    // over immediately, and a registry that somehow had no valid master elects
    // its best EXISTING stream rather than letting the newcomer win by default
    // just for arriving last. Re-registering the master under an unchanged
    // preference re-elects the same id (Map.set preserves its insertion
    // position), so the `!==` guard is also what keeps onMasterChange from
    // re-firing when nothing actually changed.
    const elected = electMaster(this.entries)
    if (elected !== null && elected !== this.currentMasterId) {
      this.promoteToMaster(elected, reference)
    }
    this.applyAudio()

    // Align BEFORE it participates: a returning stream must land on the
    // session position (the master's clock, or the preserved position of a
    // registry that had emptied) rather than start from wherever its element
    // happens to sit and then be dragged there by drift correction.
    if (reference !== null) this.alignToReference(video, reference)

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
    // Unknown id: nothing registered under it, nothing to do. Never throws -
    // teardown paths (an unmount racing another unmount, a cleanup running
    // twice) must be able to call this blindly.
    if (!entry) return

    const wasMaster = this.currentMasterId === id
    // The departing master's position IS the session position: capture it
    // before the registry (and possibly the element itself) is gone, so the
    // successor - or a stream registering much later - can pick the clock back
    // up exactly where it was left.
    const reference = entry.video.currentTime

    this.entries.delete(id)
    this.pausedForStall.delete(id)
    this.retire(entry.video)

    if (wasMaster) {
      this.lastKnownTime = reference
      this.hasReference = true

      const elected = electMaster(this.entries)
      if (elected === null) {
        // Registry empty: no master, but lastKnownTime above keeps the
        // position for whoever registers next.
        this.currentMasterId = null
        this.events.onMasterChange?.(null)
      } else {
        // Straight to the successor - deliberately NO intermediate
        // onMasterChange(null): from a consumer's point of view the audio
        // moved from one stream to another, it never went away.
        this.promoteToMaster(elected, reference)
        const next = this.entries.get(elected)
        // The master is the clock, so it has to actually run when intent is
        // playing - even if this particular stream happened to be paused
        // independently of intent (as a slave, that was harmless; as the
        // master it would freeze drift correction for everyone). If a stall
        // is really in force, the reconcile below pauses it right back and
        // records it as owed a resume, exactly like any other video.
        if (next && this.intentPlaying) safePlay(next.video)
      }
    }

    // Deliberately redundant today: `retire()` above covers the element that
    // left and `promoteToMaster()` sweeps when there's a successor, so every
    // current path is already correct without this line. It stays because
    // "every registry mutation ends with an audio sweep" is the rule that
    // makes the invariant structural instead of a case analysis someone has to
    // redo after each edit - the same reason pause() keeps its own explicit
    // stall-clearing branch.
    this.applyAudio()
    // Removing the buffering video can itself resolve a stall - and a fresh
    // master just changed who's playing, so re-derive the invariant either way.
    this.reconcileStall()
  }

  get masterId(): string | null {
    return this.currentMasterId
  }

  get currentTime(): number {
    const master = this.currentMasterId ? this.entries.get(this.currentMasterId) : undefined
    if (master) {
      // Cached so the getter keeps answering after the master leaves. NOTE: it
      // deliberately does NOT set `hasReference` - a read must not change what
      // the engine considers a real session position. unregister() and seek(),
      // the two things that actually establish one, both set it themselves.
      this.lastKnownTime = master.video.currentTime
      return master.video.currentTime
    }
    return this.lastKnownTime
  }

  /**
   * The session position a joining or promoted stream should be aligned to, or
   * `null` when the engine has no opinion yet (a fresh engine whose first
   * stream is registering: its element keeps whatever position it came with).
   */
  private referenceTime(): number | null {
    const master = this.currentMasterId ? this.entries.get(this.currentMasterId) : undefined
    if (master) return master.video.currentTime
    return this.hasReference ? this.lastKnownTime : null
  }

  /**
   * Puts `video` on the session clock without churning it: a seek only happens
   * when it's actually off by more than DRIFT_IGNORE_S - the same band `tick()`
   * treats as "in sync" - so a stream that's already where it belongs is left
   * strictly untouched (no redundant seek, no range request on a real
   * `<video>`). When a seek does happen, the playbackRate goes back to 1 for
   * the same reason `seek()` resets it: any accumulated catchup/slowdown
   * correction is stale the instant the element lands on the reference time.
   */
  private alignToReference(video: VideoLike, reference: number): void {
    if (Math.abs(video.currentTime - reference) <= DRIFT_IGNORE_S) return
    video.currentTime = reference
    video.playbackRate = 1
  }

  /**
   * Level-triggered AUDIO DISCIPLINE, and the single place any `muted` is
   * written for a registered stream: exactly one registered video is unmuted -
   * the master, at the engine volume - and every other one is muted. Like
   * `reconcileStall()`, it re-derives the whole invariant from current state on
   * every call instead of trusting a scattered set of assignments to each be
   * individually right, so it's idempotent and safe to call after any registry
   * mutation (and belt-and-braces double calls cost nothing).
   *
   * This exists because the invariant used to be spread across five assignment
   * sites in three methods, and an element swap slipped between them: the
   * incoming master element was unmuted while the displaced one stayed unmuted
   * AND playing - two simultaneous audio sources. Elements LEAVING the registry
   * (unregistered, or displaced by a swap) are out of the sweep's reach by
   * definition, so `retire()` covers them explicitly.
   */
  private applyAudio(): void {
    for (const [id, entry] of this.entries) {
      const isMaster = id === this.currentMasterId
      entry.video.muted = !isMaster
      if (isMaster) entry.video.volume = this.masterVolume
    }
  }

  /**
   * Takes an element OUT of engine control: silenced and stopped. Used for a
   * stream leaving the registry and for the element a swap displaced - in both
   * cases the engine is about to lose its handle on it, so this is the last
   * chance to make sure it can't keep playing audio (or burning bandwidth)
   * behind the session's back. The caller owns it from here: it's free to
   * destroy it, or to unmute/play it for its own purposes.
   */
  private retire(video: VideoLike): void {
    video.muted = true
    video.pause()
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
    this.hasReference = true
  }

  setVolume(v: number): void {
    this.masterVolume = v
    // Through the same sweep as every other audio change - so "the volume
    // lives on the master only" is stated once, not re-implemented here.
    this.applyAudio()
  }

  /**
   * The engine's own notion of volume - the value set via `setVolume`, not
   * any particular element's `.volume` (a slave's is always 0-irrelevant
   * since it's muted, and even the master's could in principle be nudged by
   * something outside the engine). Needed by a volume control (Task 13) that
   * has to know what to display and step from on mount/remount, when it has
   * no reactive store field of its own to read - the same reason `playing`
   * exists as a getter for intent.
   */
  get volume(): number {
    return this.masterVolume
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

  /**
   * Makes `id` the master and hands it the session clock. The OLD master isn't
   * touched here at all - `applyAudio()` mutes whoever isn't master any more,
   * and `retire()` handles one that's leaving the registry entirely.
   */
  private promoteToMaster(id: string, reference: number | null): void {
    this.currentMasterId = id
    const entry = this.entries.get(id)
    if (entry) {
      // A promoted slave may still carry a corrective CATCHUP/SLOWDOWN rate
      // from its time as a slave. The master is the clock and is never
      // rate-corrected, so nothing would ever bring that rate back to 1 - it
      // would silently run the whole session fast or slow.
      entry.video.playbackRate = 1
      if (reference !== null) this.alignToReference(entry.video, reference)
    }
    // Audio BEFORE the event: a consumer that inspects element state
    // synchronously inside onMasterChange must see the finished mute/volume
    // arrangement, not the half-applied one.
    this.applyAudio()
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
