import { describe, expect, it } from 'vitest'
import { createStreamElement, destroyStreamElement } from './mediaElements'

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
