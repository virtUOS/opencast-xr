import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencastClient } from '../opencast/client'
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

const EPISODE_FIXTURES: Record<string, unknown> = {
  'ep-1': twoStreamEpisodeFixture('ep-1', ''),
  'ep-2': twoStreamEpisodeFixture('ep-2', '-2'),
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
