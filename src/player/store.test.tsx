import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencastClient } from '../opencast/client'
import { createPlayerStore } from './store'

// jsdom's document persists across tests in this file (no testing-library
// cleanup is wired up here), and createStreamElement appends real <video>
// elements to document.body - without this, video counts leak between tests.
afterEach(() => {
  document.querySelectorAll('video').forEach((v) => v.remove())
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * Neither recorded fixture under opencast/__fixtures__ has more than one
 * video flavor, but closeStream/canClose/reopenStream all need two streams to
 * exercise "the last open stream" - so this is a minimal synthetic
 * search/episode.json response (same shape parse.ts expects) with a
 * presenter and a presentation flavor, both eligible per selectStreams
 * (video/mp4, tagged engage-download).
 */
const TWO_STREAM_EPISODE = {
  result: [
    {
      mediapackage: {
        id: 'ep-1',
        title: 'Two Stream Episode',
        duration: 60000,
        media: {
          track: [
            {
              id: 't-presenter',
              type: 'presenter/preview',
              mimetype: 'video/mp4',
              url: 'https://example.org/presenter.mp4',
              tags: { tag: ['engage-download'] },
              video: { resolution: '1280x720' },
            },
            {
              id: 't-presentation',
              type: 'presentation/preview',
              mimetype: 'video/mp4',
              url: 'https://example.org/presentation.mp4',
              tags: { tag: ['engage-download'] },
              video: { resolution: '1280x720' },
            },
          ],
        },
      },
    },
  ],
}

function makeClient(fixture: unknown = TWO_STREAM_EPISODE) {
  const fetchFn = vi.fn(async () => jsonResponse(fixture))
  return { client: new OpencastClient({ fetchFn }), fetchFn }
}

describe('createPlayerStore', () => {
  it('starts in browse mode with no episode and no streams', () => {
    const { client } = makeClient()
    const store = createPlayerStore(client)

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
      const store = createPlayerStore(client)
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
      const store = createPlayerStore(client)
      const registerSpy = vi.spyOn(store.getState().engine, 'register')

      await store.getState().openEpisode('ep-1')

      expect(registerSpy).toHaveBeenCalledTimes(2)
      expect(registerSpy.mock.calls[0][0]).toBe('presenter')
      expect(registerSpy.mock.calls[0][2]).toBe(0)
      expect(registerSpy.mock.calls[1][0]).toBe('presentation')
      expect(registerSpy.mock.calls[1][2]).toBe(1)
      expect(document.querySelectorAll('video')).toHaveLength(2)
    })
  })

  describe('closeStream / canClose', () => {
    it('unregisters and destroys the element for the closed stream', async () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)
      await store.getState().openEpisode('ep-1')
      const unregisterSpy = vi.spyOn(store.getState().engine, 'unregister')

      store.getState().closeStream('presentation')

      expect(unregisterSpy).toHaveBeenCalledWith('presentation')
      expect(store.getState().streams.find((s) => s.flavorType === 'presentation')?.open).toBe(false)
      expect(document.querySelectorAll('video')).toHaveLength(1)
    })

    it('refuses to close the only remaining open stream', async () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)
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
      const store = createPlayerStore(client)
      await store.getState().openEpisode('ep-1')

      expect(store.getState().canClose('presenter')).toBe(true)
      expect(store.getState().canClose('presentation')).toBe(true)
    })
  })

  describe('reopenStream', () => {
    it('creates a new element and re-registers it with the engine at its original preference', async () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)
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
      const store = createPlayerStore(client)
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
  })

  describe('setters', () => {
    it('setSubtitles toggles subtitlesOn', () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)

      store.getState().setSubtitles(false)
      expect(store.getState().subtitlesOn).toBe(false)
      store.getState().setSubtitles(true)
      expect(store.getState().subtitlesOn).toBe(true)
    })

    it('setSeekPreview sets and clears the preview position', () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)

      store.getState().setSeekPreview(12.5)
      expect(store.getState().seekPreviewS).toBe(12.5)
      store.getState().setSeekPreview(null)
      expect(store.getState().seekPreviewS).toBeNull()
    })
  })

  describe('stalled', () => {
    it('mirrors the engine onStall event, wired at construction', async () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)
      await store.getState().openEpisode('ep-1')
      const { engine } = store.getState()

      // Simulate one stream under-buffering while the engine intends to play
      // - readyState < 3 is the stall threshold (see syncEngine.ts).
      const presenterEl = document.querySelectorAll('video')[0] as HTMLVideoElement
      Object.defineProperty(presenterEl, 'readyState', { get: () => 0, configurable: true })

      engine.play()

      expect(store.getState().stalled).toBe(true)
    })
  })

  describe('tickOnce', () => {
    it('calls engine.tick() and mirrors engine.currentTime into currentTimeS', async () => {
      const { client } = makeClient()
      const store = createPlayerStore(client)
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
})
