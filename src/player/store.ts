import { createStore } from 'zustand'
import type { Cue, Episode } from '../opencast/types'
import type { OpencastClient } from '../opencast/client'
import { selectStreams } from '../opencast/selectTracks'
// `src/captionScale.ts` is a leaf module with no imports of its own,
// deliberately at `src/` rather than in `windows/`: `subtitleScale`'s default
// has to BE one of the size steps the dock's own button cycles through, so both
// this layer and `windows/` need the constants, and a second copy of the
// default here would silently drift from the steps array the moment either is
// retuned. Same arrangement as `src/time.ts`.
import {
  DEFAULT_CAPTION_OFFSET_DEG,
  DEFAULT_CAPTION_SCALE,
  clampCaptionOffset,
  clampCaptionScale,
} from '../captionScale'
import { SyncEngine } from './syncEngine'
import { createStreamElement, destroyStreamElement } from './mediaElements'

/** How often the store's own clock ticks the engine and mirrors its position. */
const TICK_INTERVAL_MS = 250

export interface StreamState {
  flavorType: string
  url: string
  open: boolean
  /**
   * Set when this stream's element fired a fatal `error` event (spec §9), as
   * the short human line the window's error tile shows. Cleared by
   * `reloadStream` and by any rebuild of `streams` (an episode swap, browse).
   *
   * Deliberately NOT a reason to flip `open`: the stream is still loaded as far
   * as the shell is concerned, its window stays on screen (showing the tile
   * instead of the picture), and nothing about the shell/store agreement that
   * `windows/videoWindowState.ts` reconciles changes.
   *
   * It IS, however, a reason to leave the sync engine - a dead element never
   * gets past `readyState` 0 and would stall every healthy stream forever. So
   * `open: true` with an `error` set means exactly "loaded, on screen, and no
   * longer a member of the playback session"; see `reportStreamError`.
   */
  error?: string
}

/**
 * Where browse mode should land when the player leaves an episode - the seam
 * the dock's breadcrumb needed. `LibraryWindow` has always opened at level 1
 * (the series list); a „Reihe" crumb has to open it at level 2, already scoped
 * to that series.
 *
 * Carried as a ONE-SHOT value on the store rather than as a prop or a
 * `LibraryWindow` mount key: `toBrowse` is what tears player mode down, and
 * `LibraryWindow` does not exist yet at that moment (App.tsx swaps the trees
 * on `mode`), so the intent has to survive the switch. `consumeBrowseTarget`
 * is what makes it one-shot - the window applies it once and it is gone, so a
 * later „< Zurück" inside the library goes to level 1 as normal instead of
 * being dragged back into the series it was opened at.
 *
 * `title` is carried along rather than looked up again: the crumb already knows
 * the series' display name (from the open episode's `seriesTitle`), and
 * `enterSeries` wants one immediately - without it the level-2 header would
 * read as a raw series id until an unrelated fetch happened to fill it in. It
 * is the UNtruncated title, not the crumb's own cut-to-fit label, because
 * `LibraryWindow`'s level-2 header renders it where there is room for all of it.
 */
export interface BrowseTarget {
  kind: 'series'
  sid: string
  title: string
}

export interface PlayerStore {
  mode: 'browse' | 'player'
  client: OpencastClient
  episode?: Episode
  /** Derived once per episode via selectStreams; order is the engine preference order (index = preference). */
  streams: StreamState[]
  cues: Cue[]
  subtitlesOn: boolean
  /**
   * How large the head-locked caption panel renders: the factor `SubtitleHud`
   * multiplies that panel's own design pixels by (font size, padding, corner
   * radius, `maxWidth` - all of them, which is what makes it a uniform scale
   * rather than a reflow). Lives here, not in the HUD's own `useState`, because
   * the control that changes it is in the DOCK and the thing it changes is the
   * HUD - two different subtrees, so there is no component that could own it.
   *
   * A plain number rather than a step index: the store's job is to hold one
   * clamped, positive scale, and WHICH values a press offers is the dock's
   * business (`stepCaptionScale` in `../captionScale.ts`). See
   * `setSubtitleScale`.
   */
  subtitleScale: number
  /**
   * How far the head-locked caption is nudged UP (positive) or DOWN from where
   * `<HeadLocked>` rests it, in degrees of pitch - the user's „Rauf/Runter-
   * Button, um die Schrift in der fixierten Position zu verschieben".
   *
   * Here rather than in the HUD's own `useState` for exactly the reason
   * `subtitleScale` is: the controls that change it are in the DOCK and the
   * thing they move is the HUD, two subtrees with no common component below
   * `<App>`. `SubtitleHud` adds it to `<HeadLocked config={{ offsetPitchDeg }}>`
   * (sphere-shell's per-instance override), so the whole HUD moves as one -
   * including the transient seek readout above the caption, which is the honest
   * behaviour: the two are one stack, and moving only half of it would let them
   * overlap.
   */
  subtitleOffsetDeg: number
  /**
   * Master volume as reactive state, mirrored into the engine by `setVolume`.
   *
   * `ControlsWindow` used to hold this in local `useState`, with a doc comment
   * spelling out the condition for that being safe: exactly one writer.
   * „Stummschalten" is the second writer this round adds, and the volume
   * control moved to the dock at the same time - so the local mirror would now
   * go stale exactly the way the play-intent mirror did before `playing`
   * existed. Same fix, same shape: one reactive field, one action.
   */
  volume: number
  /**
   * Session mute (spec: „Ton stumm"), mirrored into the engine by `setMuted`.
   * Distinct from `volume === 0`: muting must not destroy the level to come
   * back to, and „ist stumm" is a different question from „ist leise" for
   * anything that renders an icon off it. The engine owns the actual audio
   * discipline (see `SyncEngine.setMuted`); this is the reactive mirror.
   */
  muted: boolean
  /** One instance, lives in the store for the whole session - see syncEngine.ts. */
  engine: SyncEngine
  /** Mirrored from `engine.currentTime` on every tick - see `tickOnce`. */
  currentTimeS: number
  /** Non-null while the timeline is being dragged (HUD feedback only - does not move playback). */
  seekPreviewS: number | null
  stalled: boolean
  /**
   * The engine's play INTENT as reactive state - the value a transport control
   * renders its Play/Pause icon from (`derivePlaybackVisualState`).
   *
   * `SyncEngine.playing` is a plain getter, so a component cannot subscribe to
   * it; the dock's transport used to mirror intent in its own `useState`
   * instead, seeded from the engine and reset on an episode change. That worked
   * only as long as the component's own click was the ONLY thing that changed
   * intent while it was mounted, and it stopped being true the moment
   * `reportStreamError` started pausing the engine: the engine was paused, the
   * button still showed Pause, and its next click called `pause()` again - a
   * silent no-op the user had to click twice through. Every writer of intent
   * now goes through `setPlaying`, so there is no second copy to go stale.
   */
  playing: boolean
  /**
   * Set by `toBrowse(target)` and cleared by `consumeBrowseTarget()` - see
   * `BrowseTarget`. `null` means "browse opens at level 1", which is every
   * path except the breadcrumb's „Reihe" crumb.
   */
  browseTarget: BrowseTarget | null
  openEpisode(id: string): Promise<void>
  /**
   * The ONLY way to change play intent. Drives `engine.play()`/`engine.pause()`
   * and mirrors the result into `playing` in the same synchronous block, so the
   * two can never disagree. Every store-side pause (`openEpisode`, `toBrowse`,
   * `reportStreamError`, `dispose`) goes through it as well.
   */
  setPlaying(next: boolean): void
  /**
   * Unloads one stream: unregisters it from the engine and destroys its
   * element. Refuses to close the last open stream (see `canClose`).
   *
   * DO NOT CALL THIS DIRECTLY while the video windows are on screen. Player
   * mode renders `windows/VideoWindows.tsx`, and for as long as it is mounted
   * **the shell's window state owns open/closed**: each video window watches
   * its own sphere-shell entry and pushes any disagreement back into this store
   * (that watcher is the only way a dock-tile restore can be noticed at all -
   * sphere-shell has no `onRestore` callback). So a bare `closeStream` leaves
   * the shell window still open while the stream is closed, which the watcher
   * reads as "the user just restored it" and immediately undoes with
   * `reopenStream` - silently, with no error, at the cost of destroying,
   * recreating and re-registering the element once per attempt.
   *
   * To close a stream from anywhere else (a transport control, a keyboard
   * shortcut), close its WINDOW instead - `shellStore.close(videoWindowId(f))`,
   * or the window's own X button - and let the watcher call this.
   */
  closeStream(flavorType: string): void
  /**
   * Reloads a previously closed stream: creates a fresh element and registers
   * it with the engine at its original preference, so the engine's rejoin
   * handling puts it back on the session clock.
   *
   * Same ownership rule as `closeStream`: while `VideoWindows` is mounted this
   * is the watcher's to call (it fires it when a dock-tile click clears the
   * window's `closed` flag). Calling it directly on a stream whose window is
   * still closed in the shell gets undone the same way, in reverse.
   */
  reopenStream(flavorType: string): void
  /**
   * Spec §9's "Stream-Fehler während der Wiedergabe": records a fatal media
   * error for one stream, **pauses everything**, and takes the failed stream
   * OUT of the engine.
   *
   * Pausing the whole wall rather than just the failed stream is the spec's
   * choice and the right one: the others would otherwise run on while one
   * window is a static error tile, so the user's next resume would start from a
   * position that no longer matches what they last saw playing together. It
   * also clears the engine's play intent, so recovery needs a fresh user
   * gesture - the same discipline `openEpisode`/`toBrowse` keep.
   *
   * ## Why the failed stream must LEAVE the engine (final-review I1)
   *
   * `SyncEngine.reconcileStall` treats every registered element with
   * `readyState < 3` as "still buffering" - which is exactly right for a stream
   * that is slow, and exactly wrong for one that is dead. A 404, an ACL
   * rejection or a decode failure leaves the element stuck at `readyState` 0
   * FOREVER, so a stream left registered after its fatal error wedges the whole
   * wall: every later `play()` re-enters the stall on the same frame, every
   * healthy stream is paused right back, `stalled` latches true, and the dock
   * shows a permanent spinner. Nothing recovers it - „Neu laden" re-fails
   * against the same URL, and for the single-flavor episodes that make up
   * essentially the whole real corpus the last-stream veto (`canClose`) refuses
   * to close the window too, so the only way out was „Bibliothek".
   *
   * Unregistering solves it at the source: the dead stream stops being a member
   * whose readiness anyone waits for. Everything else about it is deliberately
   * left alone - `open` stays `true` and its element stays alive, so its window
   * (and the error tile in it) stay exactly where they were, and
   * `reloadStream`/`reopenStream` re-register it at its original preference when
   * the user asks. The engine handles both departures it can cause: an errored
   * MASTER hands the session clock to the next-best stream (Task 7's handover),
   * and an errored LAST stream leaves the registry empty with the position
   * preserved, where `play()` is a harmless no-op.
   *
   * `element` is the element the error was observed on, and is checked against
   * the one currently registered for `flavorType`: `destroyStreamElement`
   * (close, reload, episode swap) drops the `src` and calls `load()`, and a
   * late/spurious `error` event from an element that has since been replaced
   * must not paint an error tile over its healthy successor. The store is where
   * that check belongs because the store is what owns the elements.
   */
  reportStreamError(flavorType: string, element: HTMLVideoElement, message: string): void
  /**
   * The error tile's „Neu laden": throws the stream's element away and builds a
   * fresh one at the same URL and the same engine preference, clearing `error`.
   *
   * A full rebuild rather than a `load()` on the failed element: an element in
   * its error state is not reliably recoverable in place, and a new element also
   * makes the request from scratch (no stale, poisoned buffer). The engine's
   * ordinary rejoin handling then aligns it to the session clock, exactly as it
   * does for `reopenStream`.
   *
   * A no-op for an unknown or CLOSED stream - a closed stream has no element to
   * replace, and `reopenStream` is that path.
   */
  reloadStream(flavorType: string): void
  /**
   * Leaves player mode. With a `target`, browse mode opens directly at that
   * series' episode list instead of at level 1 - see `BrowseTarget`.
   */
  toBrowse(target?: BrowseTarget): void
  /**
   * Reads and clears `browseTarget` in one step, so it can only ever be
   * applied once (`LibraryWindow`'s mount effect is the only caller). A plain
   * `browseTarget` read plus a separate `clearBrowseTarget()` would leave a
   * window - a re-fired effect, a StrictMode double-invoke - in which the
   * target is applied twice, which for `enterSeries` means a second,
   * pointless page-1 fetch of the same series.
   */
  consumeBrowseTarget(): BrowseTarget | null
  setSubtitles(on: boolean): void
  /**
   * The ONLY way to change caption size. Clamps to the range the size steps
   * live in, so no caller can drive the HUD to an unreadable or absurd scale
   * (and a NaN can never reach the HUD's own pixel arithmetic, where it would
   * silently make the caption disappear rather than error).
   */
  setSubtitleScale(next: number): void
  /**
   * The ONLY way to move the caption vertically. Same clamping discipline as
   * `setSubtitleScale`, against `../captionScale.ts`'s offset range - a pitch
   * outside it either puts the caption on the video it is captioning or buries
   * it in the dock, and a NaN one puts the HUD nowhere at all.
   */
  setSubtitleOffset(next: number): void
  /**
   * The ONLY way to change master volume: drives `engine.setVolume` and
   * mirrors the value into `volume` in the same synchronous block, exactly as
   * `setPlaying` does for play intent. Clamped to [0, 1] - the range a real
   * `HTMLMediaElement.volume` accepts at all.
   */
  setVolume(v: number): void
  /**
   * The ONLY way to change session mute: drives `engine.setMuted` and mirrors
   * it into `muted`. Deliberately independent of `volume` - see the field's own
   * doc comment and `SyncEngine.setMuted`.
   */
  setMuted(on: boolean): void
  setSeekPreview(s: number | null): void
  canClose(flavorType: string): boolean
  /**
   * Runs one engine tick and mirrors `engine.currentTime` into `currentTimeS`.
   * This is the testable seam for the store's own clock: production code
   * never has to call it directly (openEpisode/toBrowse start and stop an
   * internal `setInterval` that calls it on TICK_INTERVAL_MS), but a test can
   * call it synchronously instead of dealing with real or faked timers. An
   * injectable-scheduler design was the other option considered; a plain
   * method was simpler and needed no extra constructor plumbing.
   */
  tickOnce(): void
  /**
   * The element currently registered for `flavorType`, or `undefined` if
   * that stream doesn't exist or is closed. A plain getter (not a piece of
   * reactive state) is safe here because every place that changes which
   * element is registered for a flavorType (`openEpisode`, `closeStream`,
   * `reopenStream`) also calls `set(...)` in the same synchronous block, so
   * any React binding that re-renders off the surrounding state (e.g.
   * `streams` or `mode`) is guaranteed to already see the new element by the
   * time it calls this. Needed by whatever renders the video windows
   * (Task 12) to get from a flavorType to the actual `<video>`.
   */
  getElement(flavorType: string): HTMLVideoElement | undefined
  /**
   * Stops the store's own ticking interval, cancels any `openEpisode` still in
   * flight, unregisters and destroys every open stream's element, and pauses
   * the engine. Not part of the player's
   * runtime behaviour (that's `toBrowse`, which additionally resets the
   * visible state to browse mode) - this is a teardown seam for whoever owns
   * the store's lifetime (a React unmount, HMR, or a test's `afterEach`) to
   * call so a discarded store doesn't leak its 250ms interval forever.
   */
  dispose(): void
}

/**
 * A stream joining mid-playback (reopenStream, or the initial registration of
 * a second/third stream) leaves the engine legitimately `stalled` for a beat -
 * the freshly created element starts at readyState 0. This store surfaces
 * `stalled` exactly as the engine reports it; debouncing that in the UI so a
 * momentary join-stall doesn't flash a spinner is Task 12/13's concern, not
 * this store's.
 */
export function createPlayerStore(client: OpencastClient) {
  // One <video> element per flavorType, owned by this closure so it can be
  // destroyed later (closeStream, toBrowse, or an episode swap in
  // openEpisode) - never exposed on PlayerStore's state itself, since it's
  // not part of the interface this task produces (see task-9-brief.md).
  const elementsByFlavor = new Map<string, HTMLVideoElement>()
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  /**
   * Race token for `openEpisode`, the store's only async action - the same
   * discipline `windows/libraryState.ts` and `windows/seriesState.ts` already
   * follow for their fetches. Bumped when an open STARTS, and by anything that
   * invalidates one in flight (`toBrowse`, `dispose`); an open that comes back
   * to find the counter moved on drops its result instead of applying it.
   *
   * Two things go wrong without it. Two tile clicks in quick succession
   * (`openEpisode('B')`, `openEpisode('C')`) both run to completion, so the one
   * whose LOOKUP happens to resolve last wins - the user can end up watching B
   * after asking for C. And an open still in flight when the store is disposed
   * (a React unmount, an HMR swap) goes on to append `<video>` elements to
   * `document.body`, register them into a torn-down engine, and restart the
   * 250 ms interval on a store nobody will ever dispose again.
   */
  let openGeneration = 0

  const store = createStore<PlayerStore>()((set, get) => {
    function teardownStreams(): void {
      for (const [flavorType, el] of elementsByFlavor) {
        get().engine.unregister(flavorType)
        destroyStreamElement(el)
      }
      elementsByFlavor.clear()
    }

    function startTicking(): void {
      if (intervalHandle !== null) return
      intervalHandle = setInterval(() => get().tickOnce(), TICK_INTERVAL_MS)
    }

    function stopTicking(): void {
      if (intervalHandle === null) return
      clearInterval(intervalHandle)
      intervalHandle = null
    }

    return {
      mode: 'browse',
      client,
      episode: undefined,
      streams: [],
      cues: [],
      subtitlesOn: true,
      subtitleScale: DEFAULT_CAPTION_SCALE,
      subtitleOffsetDeg: DEFAULT_CAPTION_OFFSET_DEG,
      // These two seed the mirror to `SyncEngine`'s own constructor defaults
      // (masterVolume 1, masterMuted false). Asserted in store.test.tsx rather
      // than left as a comment, so a change to either default that forgets the
      // other fails a test instead of shipping a UI that shows the wrong icon
      // until the user's first click.
      volume: 1,
      muted: false,
      engine: new SyncEngine({ onStall: (stalled) => set({ stalled }) }),
      currentTimeS: 0,
      seekPreviewS: null,
      stalled: false,
      playing: false,
      browseTarget: null,

      async openEpisode(id) {
        // Idempotent: re-opening the episode that's already showing (a
        // double-click, a re-fired effect) is a no-op rather than a
        // needless teardown+rebuild of every stream's element.
        if (get().mode === 'player' && get().episode?.id === id) return

        openGeneration += 1
        const generation = openGeneration
        // Fetch BEFORE tearing anything down: a failed/unresolved lookup
        // (client.getEpisode/loadCaptions reject with OpencastError; there's
        // no error field on this store, so the rejection propagates to the
        // caller - Task 11's transport/UI layer is expected to catch it) must
        // leave whatever was already open (browse, or a previous episode)
        // untouched rather than mutated halfway.
        const episode = await get().client.getEpisode(id)
        // Checked after EVERY await, not just the last one: the teardown below
        // is destructive, so a stale round has to bail before it, not after.
        // See openGeneration's doc comment.
        if (generation !== openGeneration) return
        if (!episode) return
        const cues = await get().client.loadCaptions(episode)
        if (generation !== openGeneration) return
        const sources = selectStreams(episode.tracks)
        // Every stream of the new recording starts open. NOTE for anyone
        // opening an episode from within player mode (that is what
        // `windows/SeriesWindow.tsx` does): this cannot reset the SHELL's
        // window state, so a flavor the user had
        // closed in the previous episode still carries `closed: true` there.
        // `windows/VideoWindows.tsx` clears that on an episode change (its
        // 'reset-window' step) - without it the video window's own state
        // watcher would read the stale flag and unload the new recording's
        // stream on arrival.
        const streams: StreamState[] = sources.map((s) => ({ flavorType: s.flavorType, url: s.url, open: true }))

        const { engine } = get()
        // Swapping episodes (including browse -> player, where this is a
        // no-op): destroy all elements, unregister all, then seek(0) on the
        // emptied engine BEFORE registering the new recording's streams - see
        // SyncEngine's "SWITCHING RECORDINGS" doc. Otherwise the first stream
        // registered below would resume at the previous session position.
        //
        // pause() FIRST, and specifically before any registration: intent is
        // sticky across an empty registry (by design - see SyncEngine's
        // "playing" doc), so if the user had pressed play on the previous
        // episode, `intentPlaying` is still true here. Without this,
        // `engine.register` below (via `reconcileToIntent`) would call
        // `safePlay` on every one of the new episode's freshly created
        // elements - i.e. the new episode would autoplay, which is exactly
        // what spec §7 forbids ("Wiedergabe startet nur auf Nutzer-Geste, nie
        // automatisch beim Episodenwechsel").
        //
        // Through `setPlaying` rather than `engine.pause()` directly, so the
        // reactive mirror the dock's transport renders from goes with it - see
        // `playing`'s doc comment.
        get().setPlaying(false)
        teardownStreams()
        engine.seek(0)

        streams.forEach((s, index) => {
          const el = createStreamElement(s.url)
          elementsByFlavor.set(s.flavorType, el)
          // Preference order is selectStreams' own order (presenter=0,
          // presentation=1, rest alphabetical) - streams is already sorted
          // that way, so the array index IS the preference.
          engine.register(s.flavorType, el, index)
        })

        set({
          episode,
          streams,
          cues,
          mode: 'player',
          currentTimeS: engine.currentTime,
          seekPreviewS: null,
          stalled: false,
        })
        startTicking()
      },

      closeStream(flavorType) {
        const target = get().streams.find((s) => s.flavorType === flavorType)
        if (!target?.open) return // already closed (or unknown): nothing to do
        if (!get().canClose(flavorType)) return // refuse: the last open stream

        get().engine.unregister(flavorType)
        const el = elementsByFlavor.get(flavorType)
        if (el) {
          destroyStreamElement(el)
          elementsByFlavor.delete(flavorType)
        }
        set((state) => ({
          // `error` goes with the element: a closed stream has no window
          // content and therefore no error tile to show, and leaving the
          // message behind would resurrect it on the next reopen - a fresh,
          // healthy element hidden behind a stale tile that only a redundant
          // „Neu laden" (another full rebuild) could clear. See reopenStream,
          // which clears it again for the same reason from the other side.
          streams: state.streams.map((s) =>
            s.flavorType === flavorType ? { ...s, open: false, error: undefined } : s,
          ),
        }))
      },

      reopenStream(flavorType) {
        const { streams, engine } = get()
        const index = streams.findIndex((s) => s.flavorType === flavorType)
        const target = streams[index]
        if (!target || target.open) return // unknown, or already open: nothing to do

        const el = createStreamElement(target.url)
        elementsByFlavor.set(flavorType, el)
        // Same preference it had originally (its position in the streams
        // array), so a rejoin doesn't reshuffle who the engine prefers as
        // master - Task 7's rejoin handling takes care of the seek itself.
        engine.register(flavorType, el, index)

        set((state) => ({
          // Cleared here as well as in closeStream, on purpose rather than by
          // accident: the element above is brand new, so whatever went wrong
          // with its predecessor cannot describe it. Belt and braces - either
          // clear alone fixes the close->reopen leak, and neither depends on
          // the other having run (a stream can also be reopened after a
          // close that never went through closeStream at all).
          streams: state.streams.map((s) =>
            s.flavorType === flavorType ? { ...s, open: true, error: undefined } : s,
          ),
        }))
      },

      reportStreamError(flavorType, element, message) {
        const target = get().streams.find((s) => s.flavorType === flavorType)
        if (!target?.open) return // closed or unknown: no window to show a tile in
        // Stale element - see the interface doc comment. Its stream has already
        // been rebuilt (or unloaded) since the error happened.
        if (elementsByFlavor.get(flavorType) !== element) return
        if (target.error === message) return // already showing exactly this
        // Intent first, registry second: `unregister` re-derives the stall
        // invariant, and doing it with intent already cleared means it has
        // nothing to reconcile - no interim stall edge for the UI to flicker
        // through on the way to a paused wall.
        get().setPlaying(false)
        // The element itself is NOT destroyed and `open` is NOT flipped - see
        // the interface doc comment. `retire()` inside unregister has already
        // muted and paused it.
        get().engine.unregister(flavorType)
        set((state) => ({
          streams: state.streams.map((s) => (s.flavorType === flavorType ? { ...s, error: message } : s)),
        }))
      },

      reloadStream(flavorType) {
        const { streams, engine } = get()
        const index = streams.findIndex((s) => s.flavorType === flavorType)
        const target = streams[index]
        if (!target?.open) return

        engine.unregister(flavorType)
        const previous = elementsByFlavor.get(flavorType)
        if (previous) destroyStreamElement(previous)
        const el = createStreamElement(target.url)
        elementsByFlavor.set(flavorType, el)
        // Same preference as originally (its index in `streams`), for the same
        // reason reopenStream keeps it: a reload must not reshuffle who the
        // engine prefers as master.
        engine.register(flavorType, el, index)

        // A NEW array even when nothing but `error` changed: `VideoWindows`
        // subscribes to `streams` and re-reads the non-reactive `getElement`
        // on every render it causes, so this identity change is what makes the
        // window pick up the replacement element at all.
        set((state) => ({
          streams: state.streams.map((s) =>
            s.flavorType === flavorType ? { ...s, error: undefined } : s,
          ),
        }))
      },

      toBrowse(target) {
        stopTicking()
        // Invalidates any open still in flight: without this, a tile click
        // followed quickly by „Bibliothek" would drag the user back into player
        // mode when the lookup finally answered. See openGeneration's doc.
        openGeneration += 1
        // Same reason as openEpisode: intent is sticky across an empty
        // registry, so leaving it playing here would autoplay the NEXT
        // episode the moment its first stream registers.
        get().setPlaying(false)
        teardownStreams()
        set({
          mode: 'browse',
          episode: undefined,
          streams: [],
          cues: [],
          currentTimeS: 0,
          seekPreviewS: null,
          stalled: false,
          // `?? null` rather than a conditional spread: an ordinary
          // toBrowse() must CLEAR any target left over from an earlier one,
          // not inherit it. Otherwise a „Reihe" crumb click, followed by
          // opening an episode and later going back with the „Home" crumb,
          // would land in that same series again.
          browseTarget: target ?? null,
        })
      },

      consumeBrowseTarget() {
        const target = get().browseTarget
        // Only writes when there is something to clear - a no-op call (the
        // common case: browse opened at level 1) must not push a new state
        // object at every subscriber.
        if (target !== null) set({ browseTarget: null })
        return target
      },

      setPlaying(next) {
        const { engine } = get()
        if (next) engine.play()
        else engine.pause()
        // Synchronously in the same block as the engine call, so no observer
        // can ever see the two disagree.
        set({ playing: next })
      },

      setSubtitles(on) {
        set({ subtitlesOn: on })
      },

      setSubtitleScale(next) {
        // The clamp - including the NaN/Infinity handling, where `Math.min/max`
        // would happily yield a NaN, and a NaN caption size makes the caption
        // silently vanish - lives in `clampCaptionScale` next to the range it
        // enforces, so the store cannot drift from it.
        set({ subtitleScale: clampCaptionScale(next) })
      },

      setSubtitleOffset(next) {
        set({ subtitleOffsetDeg: clampCaptionOffset(next) })
      },

      setVolume(v) {
        const safe = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : get().volume
        // Engine first, mirror in the same synchronous block - the `setPlaying`
        // discipline, so no observer can see the two disagree.
        get().engine.setVolume(safe)
        set({ volume: safe })
      },

      setMuted(on) {
        get().engine.setMuted(on)
        set({ muted: on })
      },

      setSeekPreview(s) {
        set({ seekPreviewS: s })
      },

      canClose(flavorType) {
        const { streams } = get()
        const target = streams.find((s) => s.flavorType === flavorType)
        if (!target?.open) return true // not open (or unknown): closing it isn't "the last open stream"
        const openCount = streams.filter((s) => s.open).length
        return openCount > 1
      },

      tickOnce() {
        const { engine } = get()
        engine.tick()
        set({ currentTimeS: engine.currentTime })
      },

      getElement(flavorType) {
        return elementsByFlavor.get(flavorType)
      },

      dispose() {
        stopTicking()
        // Cancels an openEpisode still in flight - the case this seam exists
        // for in the first place: without it the late arrival re-attaches
        // elements and restarts the interval on a store already torn down.
        openGeneration += 1
        get().setPlaying(false)
        teardownStreams()
      },
    }
  })

  return store
}

export type PlayerStoreApi = ReturnType<typeof createPlayerStore>
