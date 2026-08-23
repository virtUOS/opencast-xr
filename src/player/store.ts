import { createStore } from 'zustand'
import type { Cue, Episode } from '../opencast/types'
import type { OpencastClient } from '../opencast/client'
import { selectStreams } from '../opencast/selectTracks'
import { SyncEngine } from './syncEngine'
import { createStreamElement, destroyStreamElement } from './mediaElements'

/** How often the store's own clock ticks the engine and mirrors its position. */
const TICK_INTERVAL_MS = 250

export interface StreamState {
  flavorType: string
  url: string
  open: boolean
}

export interface PlayerStore {
  mode: 'browse' | 'player'
  client: OpencastClient
  episode?: Episode
  /** Derived once per episode via selectStreams; order is the engine preference order (index = preference). */
  streams: StreamState[]
  cues: Cue[]
  subtitlesOn: boolean
  /** One instance, lives in the store for the whole session - see syncEngine.ts. */
  engine: SyncEngine
  /** Mirrored from `engine.currentTime` on every tick - see `tickOnce`. */
  currentTimeS: number
  /** Non-null while the timeline is being dragged (HUD feedback only - does not move playback). */
  seekPreviewS: number | null
  stalled: boolean
  openEpisode(id: string): Promise<void>
  closeStream(flavorType: string): void
  reopenStream(flavorType: string): void
  toBrowse(): void
  setSubtitles(on: boolean): void
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
   * Stops the store's own ticking interval, unregisters and destroys every
   * open stream's element, and pauses the engine. Not part of the player's
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
      engine: new SyncEngine({ onStall: (stalled) => set({ stalled }) }),
      currentTimeS: 0,
      seekPreviewS: null,
      stalled: false,

      async openEpisode(id) {
        // Idempotent: re-opening the episode that's already showing (a
        // double-click, a re-fired effect) is a no-op rather than a
        // needless teardown+rebuild of every stream's element.
        if (get().mode === 'player' && get().episode?.id === id) return

        // Fetch BEFORE tearing anything down: a failed/unresolved lookup
        // (client.getEpisode/loadCaptions reject with OpencastError; there's
        // no error field on this store, so the rejection propagates to the
        // caller - Task 11's transport/UI layer is expected to catch it) must
        // leave whatever was already open (browse, or a previous episode)
        // untouched rather than mutated halfway.
        const episode = await get().client.getEpisode(id)
        if (!episode) return
        const cues = await get().client.loadCaptions(episode)
        const sources = selectStreams(episode.tracks)
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
        engine.pause()
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
          streams: state.streams.map((s) => (s.flavorType === flavorType ? { ...s, open: false } : s)),
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
          streams: state.streams.map((s) => (s.flavorType === flavorType ? { ...s, open: true } : s)),
        }))
      },

      toBrowse() {
        stopTicking()
        // Same reason as openEpisode: intent is sticky across an empty
        // registry, so leaving it playing here would autoplay the NEXT
        // episode the moment its first stream registers.
        get().engine.pause()
        teardownStreams()
        set({
          mode: 'browse',
          episode: undefined,
          streams: [],
          cues: [],
          currentTimeS: 0,
          seekPreviewS: null,
          stalled: false,
        })
      },

      setSubtitles(on) {
        set({ subtitlesOn: on })
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
        get().engine.pause()
        teardownStreams()
      },
    }
  })

  return store
}

export type PlayerStoreApi = ReturnType<typeof createPlayerStore>
