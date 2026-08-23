import { describe, expect, it } from 'vitest'
import { createStreamElement, describeMediaError, destroyStreamElement } from './mediaElements'

describe('createStreamElement', () => {
  it('creates a video element wired for silent background playback of the given url', () => {
    const v = createStreamElement('https://example.org/stream.mp4')

    expect(v.tagName).toBe('VIDEO')
    expect(v.src).toBe('https://example.org/stream.mp4')
    expect(v.muted).toBe(true)
    expect(v.playsInline).toBe(true)
    expect(v.preload).toBe('auto')
    expect(v.crossOrigin).toBe('anonymous')

    destroyStreamElement(v)
  })

  it('attaches the element to document.body with the pinned near-invisible style', () => {
    const v = createStreamElement('https://example.org/stream.mp4')

    // Deliberately NOT display:none / off-viewport - see the demo's useVideo
    // rationale this is copied from: Chrome (and likely other browsers)
    // auto-pauses muted/no-audio video-only elements that have no on-screen
    // presence at all, even ones never inserted into the DOM.
    expect(document.body.contains(v)).toBe(true)
    expect(v.style.position).toBe('fixed')
    expect(v.style.left).toBe('0px')
    expect(v.style.top).toBe('0px')
    expect(v.style.width).toBe('2px')
    expect(v.style.height).toBe('2px')
    expect(v.style.opacity).toBe('0.01')
    expect(v.style.pointerEvents).toBe('none')

    destroyStreamElement(v)
  })
})

describe('destroyStreamElement', () => {
  it('really unloads the element: paused, src cleared, load() called, removed from the DOM', () => {
    const v = createStreamElement('https://example.org/stream.mp4')
    expect(document.body.contains(v)).toBe(true)

    destroyStreamElement(v)

    expect(document.body.contains(v)).toBe(false)
    expect(v.hasAttribute('src')).toBe(false)
    expect(v.getAttribute('src')).toBeNull()
  })

  it('is safe to call on an element that was never attached', () => {
    const v = document.createElement('video')
    v.src = 'https://example.org/stream.mp4'

    expect(() => destroyStreamElement(v)).not.toThrow()
    expect(v.hasAttribute('src')).toBe(false)
  })
})

describe('describeMediaError', () => {
  // A plain object, not a real MediaError: constructing one is not possible
  // from script, and only `code`/`message` are read.
  const err = (code: number, message = ''): MediaError => ({ code, message }) as MediaError

  it('names the cause per MediaError code', () => {
    expect(describeMediaError(err(1))).toBe('Laden abgebrochen')
    expect(describeMediaError(err(2))).toBe('Netzwerkfehler im Stream')
    expect(describeMediaError(err(3))).toBe('Stream nicht dekodierbar')
    expect(describeMediaError(err(4))).toBe('Stream nicht erreichbar oder nicht unterstützt')
  })

  it('falls back to a sentence for a missing or unknown error', () => {
    expect(describeMediaError(null)).toBe('Unbekannter Stream-Fehler')
    expect(describeMediaError(undefined)).toBe('Unbekannter Stream-Fehler')
    expect(describeMediaError(err(99))).toBe('Unbekannter Stream-Fehler')
  })

  it("appends the browser's own message when there is one", () => {
    expect(describeMediaError(err(2, 'NETWORK_ERROR'))).toBe('Netzwerkfehler im Stream (NETWORK_ERROR)')
  })

  it('truncates a long message so the error tile stays one short line', () => {
    // Long, internal-looking messages are what Chrome actually produces here.
    const line = describeMediaError(err(4, 'DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed'))

    expect(line).toContain('DEMUXER_ERROR_COULD_NOT_OPEN')
    expect(line.endsWith('...)')).toBe(true)
    // The parenthesised detail is capped (44 chars incl. the "..."), so the
    // whole line stays inside what a video window can render on one or two
    // lines - see ERROR_DETAIL_MAX_CHARS' doc comment.
    expect(line.length).toBeLessThanOrEqual('Stream nicht erreichbar oder nicht unterstützt'.length + 3 + 44)
  })
})
