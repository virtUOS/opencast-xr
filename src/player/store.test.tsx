import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencastClient } from '../opencast/client'
import { derivePlaybackVisualState } from '../windows/transportState'
import { createPlayerStore, type PlayerStoreApi } from './store'

// Tracks every store created by makeStore() below so afterEach can dispose()
// each one - stopping its ticking interval and pausing/tearing down its
// engine - before the next test runs. Without this, any test that reaches
// player mode (7 of the tests below) leaks a live 250ms interval forever.
let stores: PlayerStoreApi[] = []

function makeStore(client: OpencastClient): PlayerStoreApi {
  const store = createPlayerStore(client)
  stores.push(store)
  return store
}

afterEach(() => {
  // Defensive: a fake-timers test that throws before its own
  // vi.useRealTimers() would otherwise leave every later test's real timers
  // faked too.
  vi.useRealTimers()
  for (const store of stores) store.getState().dispose()
  stores = []
  // jsdom's document persists across tests in this file (no testing-library
  // cleanup is wired up here), and createStreamElement appends real <video>
  // elements to document.body - dispose() above already destroys every
  // element the store itself tracked, this is just a safety net.
  document.querySelectorAll('video').forEach((v) => v.remove())
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Neither recorded fixture under opencast/__fixtures__ has more than one
 * video flavor, but closeStream/canClose/reopenStream all need two streams to
 * exercise "the last open stream" - so these are minimal synthetic
 * search/episode.json responses (same shape parse.ts expects), each with a
 * presenter and a presentation flavor, both eligible per selectStreams
 * (video/mp4, tagged engage-download). Two distinct episodes (ep-1/ep-2) so
 * episode-swap tests can tell the old and new episode's elements apart.
 */
function twoStreamEpisodeFixture(id: string, suffix: string) {
  return {
    result: [
      {
        mediapackage: {
          id,
          title: `Episode ${id}`,
          duration: 60000,
          media: {
            track: [
              {
                id: `${id}-t-presenter`,
                type: 'presenter/preview',
                mimetype: 'video/mp4',
                url: `https://example.org/presenter${suffix}.mp4`,
                tags: { tag: ['engage-download'] },
                video: { resolution: '1280x720' },
              },
              {
                id: `${id}-t-presentation`,
                type: 'presentation/preview',
                mimetype: 'video/mp4',
                url: `https://example.org/presentation${suffix}.mp4`,
                tags: { tag: ['engage-download'] },
                video: { resolution: '1280x720' },
              },
            ],
          },
        },
      },
    ],
  }
}

/**
 * The single-flavor shape, which is what almost every real recording is (all
 * 20 episodes on develop.opencast.org at the time of writing): one stream, so
 * `canClose` vetoes closing its window and the error tile is the ONLY thing on
 * screen for that flavor. The interesting case for `reportStreamError`, since
 * dropping the failed stream empties the engine outright.
 */
function oneStreamEpisodeFixture(id: string) {
  return {
    result: [
      {
        mediapackage: {
          id,
          title: `Episode ${id}`,
          duration: 60000,
          media: {
            track: [
              {
                id: `${id}-t-presenter`,
                type: 'presenter/preview',
                mimetype: 'video/mp4',
                url: 'https://example.org/solo.mp4',
                tags: { tag: ['engage-download'] },
                video: { resolution: '1280x720' },
              },
            ],
          },
        },
      },
    ],
  }
}

const EPISODE_FIXTURES: Record<string, unknown> = {
  'ep-1': twoStreamEpisodeFixture('ep-1', ''),
  'ep-2': twoStreamEpisodeFixture('ep-2', '-2'),
  'ep-3': twoStreamEpisodeFixture('ep-3', '-3'),
  'ep-solo': oneStreamEpisodeFixture('ep-solo'),
}

/** A client whose fetchFn resolves /search/episode.json?id=... against EPISODE_FIXTURES. */
function makeClient() {
  const fetchFn = vi.fn<FetchStub>(async (input) => {
    const url = new URL(String(input))
    const id = url.searchParams.get('id') ?? 'ep-1'
    return jsonResponse(EPISODE_FIXTURES[id])
  })
  return { client: new OpencastClient({ fetchFn }), fetchFn }
}

/**
 * A client whose episode lookups hang until the test resolves them BY ID, in
 * whatever order it likes - the only way to prove `openEpisode`'s race token
 * actually decides the winner rather than "whoever resolved last" doing it.
 * `settle(id)` answers one pending lookup from EPISODE_FIXTURES.
 */
function makeDeferredClient() {
  const pending = new Map<string, (r: Response) => void>()
  const fetchFn = vi.fn<FetchStub>((input) => {
    const url = new URL(String(input))
    const id = url.searchParams.get('id') ?? 'ep-1'
    return new Promise<Response>((resolve) => pending.set(id, resolve))
  })
  return {
    client: new OpencastClient({ fetchFn }),
    /** Resolves the lookup for `id`; returns a promise for the microtasks it unblocks. */
    async settle(id: string) {
      const resolve = pending.get(id)
      if (!resolve) throw new Error(`no pending episode lookup for ${id}`)
      pending.delete(id)
      resolve(jsonResponse(EPISODE_FIXTURES[id]))
      // Two turns: one for the getEpisode await, one for the loadCaptions
      // await that openEpisode does right after it (these fixtures carry no
      // captions track, so it resolves without another fetch).
      await Promise.resolve()
      await Promise.resolve()
    },
    pendingIds: () => [...pending.keys()],
  }
}

/**
 * jsdom's `<video>` reports `readyState` 0 and `currentTime` 0 and never
 * changes either (no decode happens), so any test about the engine's stall
 * threshold or session clock has to say what the element pretends to be. An
 * own property shadows the prototype accessor for this one element only.
 */
function fakeMedia(el: HTMLVideoElement, values: { readyState?: number; currentTime?: number }): void {
  if (values.readyState !== undefined) {
    Object.defineProperty(el, 'readyState', { get: () => values.readyState, configurable: true })
  }
  if (values.currentTime !== undefined) {
    Object.defineProperty(el, 'currentTime', { value: values.currentTime, writable: true, configurable: true })
  }
}

/** `readyState` 4 = HAVE_ENOUGH_DATA: a stream that is genuinely playable. */
const READY = 4

describe('createPlayerStore', () => {
  it('starts in browse mode with no episode and no streams', () => {
    const { client } = makeClient()
    const store = makeStore(client)

    const state = store.getState()
    expect(state.mode).toBe('browse')
    expect(state.episode).toBeUndefined()
    expect(state.streams).toEqual([])
    expect(state.cues).toEqual([])
    expect(state.stalled).toBe(false)
    expect(state.seekPreviewS).toBeNull()
  })

  describe('openEpisode', () => {
    it('loads the episode, builds streams/cues, switches to player mode, and does not autoplay', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      const playSpy = vi.spyOn(store.getState().engine, 'play')

      await store.getState().openEpisode('ep-1')

      const state = store.getState()
      expect(state.mode).toBe('player')
      expect(state.episode?.id).toBe('ep-1')
      expect(state.streams).toEqual([
        { flavorType: 'presenter', url: 'https://example.org/presenter.mp4', open: true },
        { flavorType: 'presentation', url: 'https://example.org/presentation.mp4', open: true },
      ])
      expect(state.cues).toEqual([])
      expect(playSpy).not.toHaveBeenCalled()
    })

    it('registers one element per stream with the engine, in selectStreams order (presenter=0, presentation=1)', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      const registerSpy = vi.spyOn(store.getState().engine, 'register')

      await store.getState().openEpisode('ep-1')

      expect(registerSpy).toHaveBeenCalledTimes(2)
      expect(registerSpy.mock.calls[0][0]).toBe('presenter')
      expect(registerSpy.mock.calls[0][2]).toBe(0)
      expect(registerSpy.mock.calls[1][0]).toBe('presentation')
      expect(registerSpy.mock.calls[1][2]).toBe(1)
      expect(document.querySelectorAll('video')).toHaveLength(2)
    })

    it('is idempotent: re-opening the already-open episode is a complete no-op', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const stateBefore = store.getState()
      const registerSpy = vi.spyOn(stateBefore.engine, 'register')

      await store.getState().openEpisode('ep-1')

      expect(registerSpy).not.toHaveBeenCalled()
      // No set() call happened at all - same state object, not just
      // equal-by-value.
      expect(store.getState()).toBe(stateBefore)
    })

    it('never autoplays across an episode swap, even if the previous episode was playing', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      // Simulate the user having pressed play on the first episode.
      store.getState().engine.play()
      expect(store.getState().engine.playing).toBe(true)

      const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')

      await store.getState().openEpisode('ep-2')

      expect(store.getState().episode?.id).toBe('ep-2')
      expect(store.getState().streams.map((s) => s.url)).toEqual([
        'https://example.org/presenter-2.mp4',
        'https://example.org/presentation-2.mp4',
      ])
      // The defining regression: engine play-intent must be cleared BEFORE
      // the new episode's elements register, or register()'s
      // reconcileToIntent step calls safePlay() on every one of them.
      expect(store.getState().engine.playing).toBe(false)
      expect(playSpy).not.toHaveBeenCalled()
      for (const v of document.querySelectorAll('video')) {
        expect((v as HTMLVideoElement).paused).toBe(true)
      }
    })

    describe('race token', () => {
      it('the LAST requested episode wins, whatever order the lookups resolve in', async () => {
        const { client, settle } = makeDeferredClient()
        const store = makeStore(client)
        const captionsSpy = vi.spyOn(client, 'loadCaptions')

        // Two tile clicks in quick succession, neither awaited - exactly what
        // the series window's episode list can produce.
        const first = store.getState().openEpisode('ep-1')
        const second = store.getState().openEpisode('ep-3')
        // ...and the SECOND one comes back first, so "whoever resolves last
        // wins" would hand the session to ep-1.
        await settle('ep-3')
        await settle('ep-1')
        await Promise.all([first, second])

        // The check after the FIRST await, specifically: a superseded round
        // stops right there instead of going on to fetch captions it will
        // never use (a real request against a real server).
        expect(captionsSpy).toHaveBeenCalledTimes(1)
        expect(captionsSpy.mock.calls[0][0].id).toBe('ep-3')
        expect(store.getState().episode?.id).toBe('ep-3')
        expect(store.getState().streams.map((s) => s.url)).toEqual([
          'https://example.org/presenter-3.mp4',
          'https://example.org/presentation-3.mp4',
        ])
        // The stale round must not have built elements either - two, not four.
        expect(document.querySelectorAll('video')).toHaveLength(2)
        for (const s of store.getState().streams) {
          expect(store.getState().getElement(s.flavorType)?.getAttribute('src')).toBe(s.url)
        }
      })

      it('dispose() mid-open cancels it: no elements, no registrations, no interval', async () => {
        vi.useFakeTimers()
        const { client, settle } = makeDeferredClient()
        const store = makeStore(client)
        const registerSpy = vi.spyOn(store.getState().engine, 'register')
        const tickSpy = vi.spyOn(store.getState(), 'tickOnce')

        const opening = store.getState().openEpisode('ep-1')
        store.getState().dispose()
        await settle('ep-1')
        await opening

        // Without the token this appended <video>s to document.body, registered
        // them into a torn-down engine and restarted the 250 ms interval - on a
        // store nobody would ever dispose again.
        expect(document.querySelectorAll('video')).toHaveLength(0)
        expect(registerSpy).not.toHaveBeenCalled()
        expect(store.getState().mode).toBe('browse')
        vi.advanceTimersByTime(1000)
        expect(tickSpy).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('dispose() BETWEEN the two lookups cancels it too (the check after the second await)', async () => {
        // The episode lookup resolves immediately here, so the store is
        // parked on the CAPTIONS await when it is disposed - the window the
        // check after the first await cannot see.
        const { client } = makeClient()
        const store = makeStore(client)
        let releaseCaptions = () => {}
        const captionsAwaited = new Promise<void>((reached) => {
          vi.spyOn(client, 'loadCaptions').mockImplementation(
            () =>
              new Promise((resolve) => {
                releaseCaptions = () => resolve([])
                reached()
              }),
          )
        })
        const registerSpy = vi.spyOn(store.getState().engine, 'register')

        const opening = store.getState().openEpisode('ep-1')
        await captionsAwaited
        store.getState().dispose()
        releaseCaptions()
        await opening

        expect(document.querySelectorAll('video')).toHaveLength(0)
        expect(registerSpy).not.toHaveBeenCalled()
        expect(store.getState().mode).toBe('browse')
      })

      it('toBrowse() mid-open cancels it, so a late arrival cannot drag the user back into the player', async () => {
        const { client, settle } = makeDeferredClient()
        const store = makeStore(client)

        const opening = store.getState().openEpisode('ep-1')
        store.getState().toBrowse()
        await settle('ep-1')
        await opening

        expect(store.getState().mode).toBe('browse')
        expect(store.getState().episode).toBeUndefined()
        expect(store.getState().streams).toEqual([])
        expect(document.querySelectorAll('video')).toHaveLength(0)
      })
    })
  })

  describe('closeStream / canClose', () => {
    it('unregisters and destroys the element for the closed stream', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const unregisterSpy = vi.spyOn(store.getState().engine, 'unregister')

      store.getState().closeStream('presentation')

      expect(unregisterSpy).toHaveBeenCalledWith('presentation')
      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.open).toBe(false)
      expect(document.querySelectorAll('video')).toHaveLength(1)
    })

    it('refuses to close the only remaining open stream', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      store.getState().closeStream('presentation')
      const unregisterSpy = vi.spyOn(store.getState().engine, 'unregister')

      expect(store.getState().canClose('presenter')).toBe(false)

      store.getState().closeStream('presenter')

      expect(unregisterSpy).not.toHaveBeenCalled()
      expect(store.getState().streams.find((s) => s.flavorType === 'presenter')?.open).toBe(true)
      expect(document.querySelectorAll('video')).toHaveLength(1)
    })

    it('canClose is true for either stream while both are open', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')

      expect(store.getState().canClose('presenter')).toBe(true)
      expect(store.getState().canClose('presentation')).toBe(true)
    })
  })

  describe('reopenStream', () => {
    it('creates a new element and re-registers it with the engine at its original preference', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      store.getState().closeStream('presentation')
      const registerSpy = vi.spyOn(store.getState().engine, 'register')

      store.getState().reopenStream('presentation')

      expect(registerSpy).toHaveBeenCalledTimes(1)
      expect(registerSpy.mock.calls[0][0]).toBe('presentation')
      expect(registerSpy.mock.calls[0][2]).toBe(1)
      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.open).toBe(true)
      expect(document.querySelectorAll('video')).toHaveLength(2)
    })
  })

  describe('reportStreamError / reloadStream', () => {
    it('records the error on that stream and pauses every stream (spec §9)', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      store.getState().engine.play()
      expect(store.getState().engine.playing).toBe(true)
      const failed = store.getState().getElement('presentation')!

      store.getState().reportStreamError('presentation', failed, 'Netzwerkfehler im Stream')

      const streams = store.getState().streams
      expect(streams.find((s) => s.flavorType === 'presentation')?.error).toBe('Netzwerkfehler im Stream')
      // The healthy stream keeps no error of its own, but is stopped with the
      // rest - and the engine's intent is cleared, so resuming needs a gesture.
      expect(streams.find((s) => s.flavorType === 'presenter')?.error).toBeUndefined()
      expect(store.getState().engine.playing).toBe(false)
      expect(store.getState().getElement('presenter')?.paused).toBe(true)
      expect(failed.paused).toBe(true)
      // The stream is NOT unloaded: its window stays on screen for the tile.
      expect(streams.find((s) => s.flavorType === 'presentation')?.open).toBe(true)
      expect(document.querySelectorAll('video')).toHaveLength(2)
    })

    it('REGRESSION: drops the failed stream from the engine, so the others are not wedged behind it', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const healthy = store.getState().getElement('presenter')!
      const dead = store.getState().getElement('presentation')!
      // The 404/ACL shape: one element never gets past readyState 0 while the
      // other is fully buffered.
      fakeMedia(healthy, { readyState: READY })
      fakeMedia(dead, { readyState: 0 })

      // Before the error the dead stream legitimately stalls the whole wall -
      // that is `reconcileStall`'s job while it is still a member.
      store.getState().setPlaying(true)
      expect(store.getState().stalled).toBe(true)

      store.getState().reportStreamError('presentation', dead, 'Netzwerkfehler im Stream')

      // The bug: a permanently-failed stream stayed registered, so it kept
      // reporting readyState < 3 forever - every later play() re-entered the
      // stall immediately, LoaderCircle latched, and NOTHING could play again.
      store.getState().setPlaying(true)
      expect(store.getState().stalled).toBe(false)
      expect(healthy.paused).toBe(false)
      // The failed element is out of engine control (retired: muted, paused)
      // but still loaded, so its window keeps showing the tile.
      expect(dead.paused).toBe(true)
      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')).toMatchObject({
        open: true,
        error: 'Netzwerkfehler im Stream',
      })
      expect(store.getState().getElement('presentation')).toBe(dead)
      expect(document.querySelectorAll('video')).toHaveLength(2)
    })

    it('hands the session clock over when the FAILED stream was the master', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const master = store.getState().getElement('presenter')!
      const successor = store.getState().getElement('presentation')!
      expect(store.getState().engine.masterId).toBe('presenter')
      fakeMedia(master, { readyState: 0, currentTime: 12.5 })
      fakeMedia(successor, { readyState: READY, currentTime: 12.5 })

      store.getState().reportStreamError('presenter', master, 'Netzwerkfehler im Stream')

      // Task 7's handover, now reachable from an error: the departing master's
      // position becomes the session position and the next-best stream picks
      // the clock up - no masterless-but-populated engine, no silence.
      expect(store.getState().engine.masterId).toBe('presentation')
      expect(store.getState().engine.currentTime).toBe(12.5)
      expect(successor.muted).toBe(false)
      store.getState().setPlaying(true)
      expect(successor.paused).toBe(false)
    })

    it('empties the engine for a single-flavor episode instead of wedging it, and reload recovers', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-solo')
      const only = store.getState().getElement('presenter')!
      fakeMedia(only, { readyState: 0, currentTime: 30 })
      // The window cannot be closed either (spec's last-stream veto), which is
      // what made this the total dead end the tile now names an escape from.
      expect(store.getState().canClose('presenter')).toBe(false)

      store.getState().reportStreamError('presenter', only, 'Stream nicht gefunden (404)')

      expect(store.getState().engine.masterId).toBeNull()
      // Task 7's rule: the position survives an emptied registry.
      expect(store.getState().engine.currentTime).toBe(30)
      // Play on an empty engine is harmless - no throw, no latched stall.
      store.getState().setPlaying(true)
      expect(store.getState().stalled).toBe(false)
      store.getState().tickOnce()
      expect(store.getState().currentTimeS).toBe(30)

      store.getState().reloadStream('presenter')

      const fresh = store.getState().getElement('presenter')!
      expect(fresh).not.toBe(only)
      expect(store.getState().engine.masterId).toBe('presenter')
      expect(store.getState().streams[0].error).toBeUndefined()
      // Rejoined ON the preserved session clock, not back at 0.
      expect(fresh.currentTime).toBe(30)
    })

    it('ignores a report from an element that is no longer the registered one', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const stale = store.getState().getElement('presentation')!
      // Any rebuild of that stream's element: destroyStreamElement drops the
      // src and calls load(), which can dispatch a late error event.
      store.getState().reloadStream('presentation')
      store.getState().engine.play()

      store.getState().reportStreamError('presentation', stale, 'Netzwerkfehler im Stream')

      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.error).toBeUndefined()
      expect(store.getState().engine.playing).toBe(true)
    })

    it('ignores a report for a closed or unknown stream', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const closed = store.getState().getElement('presentation')!
      store.getState().closeStream('presentation')
      store.getState().engine.play()

      store.getState().reportStreamError('presentation', closed, 'Netzwerkfehler im Stream')
      store.getState().reportStreamError('nope', closed, 'Netzwerkfehler im Stream')

      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.error).toBeUndefined()
      expect(store.getState().engine.playing).toBe(true)
    })

    it('reloadStream replaces the element, clears the error, and re-registers at the original preference', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const failed = store.getState().getElement('presentation')!
      store.getState().reportStreamError('presentation', failed, 'Netzwerkfehler im Stream')
      const registerSpy = vi.spyOn(store.getState().engine, 'register')
      const unregisterSpy = vi.spyOn(store.getState().engine, 'unregister')
      const streamsBefore = store.getState().streams

      store.getState().reloadStream('presentation')

      expect(unregisterSpy).toHaveBeenCalledWith('presentation')
      expect(registerSpy).toHaveBeenCalledTimes(1)
      expect(registerSpy.mock.calls[0][0]).toBe('presentation')
      expect(registerSpy.mock.calls[0][2]).toBe(1) // unchanged preference
      const fresh = store.getState().getElement('presentation')
      expect(fresh).toBeDefined()
      expect(fresh).not.toBe(failed)
      expect(fresh?.getAttribute('src')).toBe('https://example.org/presentation.mp4')
      expect(document.body.contains(failed)).toBe(false)
      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.error).toBeUndefined()
      // New array identity - that is what makes VideoWindows re-read getElement.
      expect(store.getState().streams).not.toBe(streamsBefore)
      // Still no autoplay: recovery waits for a user gesture.
      expect(store.getState().engine.playing).toBe(false)
      expect(document.querySelectorAll('video')).toHaveLength(2)
    })

    it('reloadStream is a no-op for a closed or unknown stream', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      store.getState().closeStream('presentation')
      const registerSpy = vi.spyOn(store.getState().engine, 'register')

      store.getState().reloadStream('presentation')
      store.getState().reloadStream('nope')

      expect(registerSpy).not.toHaveBeenCalled()
      expect(store.getState().getElement('presentation')).toBeUndefined()
      expect(document.querySelectorAll('video')).toHaveLength(1)
    })

    it('closing an errored stream drops its error, and reopening comes back clean', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const failed = store.getState().getElement('presentation')!
      store.getState().reportStreamError('presentation', failed, 'Netzwerkfehler im Stream')

      store.getState().closeStream('presentation')

      // A closed stream has no window content, so there is no tile to show -
      // and leaving the message behind would resurrect it over the next,
      // healthy element.
      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')).toEqual({
        flavorType: 'presentation',
        url: 'https://example.org/presentation.mp4',
        open: false,
        error: undefined,
      })

      store.getState().reopenStream('presentation')

      const reopened = store.getState().streams.find((s) => s.flavorType === 'presentation')
      expect(reopened?.open).toBe(true)
      expect(reopened?.error).toBeUndefined()
      // ...and the element behind it is a real, fresh one, not the failed one.
      const fresh = store.getState().getElement('presentation')
      expect(fresh).toBeDefined()
      expect(fresh).not.toBe(failed)
      expect(fresh?.getAttribute('src')).toBe('https://example.org/presentation.mp4')
    })

    it('reopenStream clears an error even when the close did not go through closeStream', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const failed = store.getState().getElement('presentation')!
      store.getState().reportStreamError('presentation', failed, 'Netzwerkfehler im Stream')
      // Hand-built "closed with the error still on it": the state closeStream
      // used to leave behind, and the state any other close path could still
      // produce. Each clear has to stand on its own.
      store.setState((state) => ({
        streams: state.streams.map((s) => (s.flavorType === 'presentation' ? { ...s, open: false } : s)),
      }))

      store.getState().reopenStream('presentation')

      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.error).toBeUndefined()
    })

    it('an episode swap clears a stream error from the previous episode', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const failed = store.getState().getElement('presentation')!
      store.getState().reportStreamError('presentation', failed, 'Netzwerkfehler im Stream')

      await store.getState().openEpisode('ep-2')

      // openEpisode rebuilds `streams` from scratch, so the new recording's
      // entries are clean by construction rather than by an explicit clear -
      // pinned here because "by construction" is exactly the kind of property
      // a later refactor (e.g. carrying state across a swap) can quietly lose.
      expect(store.getState().streams).toEqual([
        { flavorType: 'presenter', url: 'https://example.org/presenter-2.mp4', open: true },
        { flavorType: 'presentation', url: 'https://example.org/presentation-2.mp4', open: true },
      ])
      expect(store.getState().streams.every((s) => s.error === undefined)).toBe(true)
    })
  })

  describe('playing / setPlaying', () => {
    it('is the single writer of play intent: it drives the engine AND the reactive mirror', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      for (const el of document.querySelectorAll('video')) fakeMedia(el as HTMLVideoElement, { readyState: READY })
      expect(store.getState().playing).toBe(false)

      store.getState().setPlaying(true)

      expect(store.getState().playing).toBe(true)
      expect(store.getState().engine.playing).toBe(true)
      expect(store.getState().getElement('presenter')?.paused).toBe(false)

      store.getState().setPlaying(false)

      expect(store.getState().playing).toBe(false)
      expect(store.getState().engine.playing).toBe(false)
      expect(store.getState().getElement('presenter')?.paused).toBe(true)
    })

    it('an episode swap and toBrowse both clear it, in step with the engine', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      store.getState().setPlaying(true)

      await store.getState().openEpisode('ep-2')

      expect(store.getState().playing).toBe(false)
      expect(store.getState().engine.playing).toBe(false)

      store.getState().setPlaying(true)
      store.getState().toBrowse()

      expect(store.getState().playing).toBe(false)
      expect(store.getState().engine.playing).toBe(false)
    })

    it('REGRESSION: a stream error clears it, so the dock shows Play and the first click resumes', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const healthy = store.getState().getElement('presenter')!
      const dead = store.getState().getElement('presentation')!
      fakeMedia(healthy, { readyState: READY })
      fakeMedia(dead, { readyState: 0 })
      store.getState().setPlaying(true)

      store.getState().reportStreamError('presentation', dead, 'Netzwerkfehler im Stream')

      // The bug this pins: `reportStreamError` pauses the engine, so a
      // component mirroring intent in its own useState kept showing Pause and
      // its next click called pause() again - a no-op. One reactive field means
      // there is nothing left to go stale.
      expect(store.getState().playing).toBe(false)
      expect(store.getState().engine.playing).toBe(false)
      expect(derivePlaybackVisualState(store.getState().playing, store.getState().stalled)).toBe('play')

      store.getState().setPlaying(true)

      expect(store.getState().playing).toBe(true)
      expect(healthy.paused).toBe(false)
      expect(derivePlaybackVisualState(store.getState().playing, store.getState().stalled)).toBe('pause')
    })
  })

  describe('toBrowse', () => {
    it('unregisters and destroys every stream and clears episode state', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const unregisterSpy = vi.spyOn(store.getState().engine, 'unregister')

      store.getState().toBrowse()

      expect(unregisterSpy).toHaveBeenCalledWith('presenter')
      expect(unregisterSpy).toHaveBeenCalledWith('presentation')
      expect(document.querySelectorAll('video')).toHaveLength(0)

      const state = store.getState()
      expect(state.mode).toBe('browse')
      expect(state.episode).toBeUndefined()
      expect(state.streams).toEqual([])
    })

    it('never autoplays the next episode opened after toBrowse, even if the previous episode was playing', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      store.getState().engine.play()
      expect(store.getState().engine.playing).toBe(true)

      store.getState().toBrowse()
      expect(store.getState().engine.playing).toBe(false)

      const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')
      await store.getState().openEpisode('ep-2')

      expect(store.getState().engine.playing).toBe(false)
      expect(playSpy).not.toHaveBeenCalled()
      for (const v of document.querySelectorAll('video')) {
        expect((v as HTMLVideoElement).paused).toBe(true)
      }
    })
  })

  describe('setters', () => {
    it('setSubtitles toggles subtitlesOn', () => {
      const { client } = makeClient()
      const store = makeStore(client)

      store.getState().setSubtitles(false)
      expect(store.getState().subtitlesOn).toBe(false)
      store.getState().setSubtitles(true)
      expect(store.getState().subtitlesOn).toBe(true)
    })

    it('setSeekPreview sets and clears the preview position', () => {
      const { client } = makeClient()
      const store = makeStore(client)

      store.getState().setSeekPreview(12.5)
      expect(store.getState().seekPreviewS).toBe(12.5)
      store.getState().setSeekPreview(null)
      expect(store.getState().seekPreviewS).toBeNull()
    })
  })

  describe('getElement', () => {
    it('returns the live element for an open stream, and undefined for a closed or unknown one', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')

      const presenterEl = store.getState().getElement('presenter')
      expect(presenterEl).toBeInstanceOf(HTMLVideoElement)
      expect(presenterEl?.src).toBe('https://example.org/presenter.mp4')
      expect(store.getState().getElement('no-such-flavor')).toBeUndefined()

      store.getState().closeStream('presentation')
      expect(store.getState().getElement('presentation')).toBeUndefined()
    })
  })

  describe('stalled', () => {
    it('mirrors the engine onStall event, and the engine really pauses the stalled elements', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const { engine } = store.getState()
      const [presenterEl, presentationEl] = [...document.querySelectorAll('video')] as HTMLVideoElement[]

      // Simulate one stream under-buffering while the engine intends to play
      // - readyState < 3 is the stall threshold (see syncEngine.ts).
      Object.defineProperty(presenterEl, 'readyState', { get: () => 0, configurable: true })

      engine.play()

      expect(store.getState().stalled).toBe(true)
      // Real play()/pause() semantics now (mediaElementStubs.ts), so this
      // checks the engine actually paused every element while buffering -
      // not just that it reported the flag.
      expect(presenterEl.paused).toBe(true)
      expect(presentationEl.paused).toBe(true)
    })
  })

  describe('tickOnce', () => {
    it('calls engine.tick() and mirrors engine.currentTime into currentTimeS', async () => {
      const { client } = makeClient()
      const store = makeStore(client)
      await store.getState().openEpisode('ep-1')
      const engine = store.getState().engine
      const tickSpy = vi.spyOn(engine, 'tick')
      // engine.currentTime is a getter; redefine it on the instance to make
      // the mirroring assertion independent of jsdom's fake <video> elements
      // ever actually advancing (they never do - no real decode happens).
      Object.defineProperty(engine, 'currentTime', { get: () => 42, configurable: true })

      store.getState().tickOnce()

      expect(tickSpy).toHaveBeenCalledTimes(1)
      expect(store.getState().currentTimeS).toBe(42)
    })
  })

  describe('ticking scheduler', () => {
    it('runs exactly one interval while a player is open, none while browsing, and does not stack across a swap', async () => {
      vi.useFakeTimers()
      const { client } = makeClient()
      const store = makeStore(client)
      const tickSpy = vi.spyOn(store.getState(), 'tickOnce')

      await store.getState().openEpisode('ep-1')
      vi.advanceTimersByTime(250)
      expect(tickSpy).toHaveBeenCalledTimes(1)

      // Swapping to another episode while one is already open must not
      // stack a second interval on top of the first (startTicking() is
      // guarded, but this is what actually proves it).
      tickSpy.mockClear()
      await store.getState().openEpisode('ep-2')
      vi.advanceTimersByTime(250)
      expect(tickSpy).toHaveBeenCalledTimes(1)

      tickSpy.mockClear()
      store.getState().toBrowse()
      vi.advanceTimersByTime(1000)
      expect(tickSpy).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })
})
