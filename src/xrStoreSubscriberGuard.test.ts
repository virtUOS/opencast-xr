import { createStore } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { guardXRStoreSubscriber } from './xrStoreSubscriberGuard'

/**
 * These tests use a REAL `zustand/vanilla` store (the same package - and the
 * same `listeners.forEach` notification loop - `xrStore` is built from) to
 * reproduce the exact hazard `xrStoreSubscriberGuard.ts`'s doc comment
 * describes, then prove the guard closes it. Not a mock of the mechanism:
 * this IS the mechanism.
 */
describe('the zustand notification hazard (unwrapped)', () => {
  it('an unguarded subscriber that throws prevents every LATER subscriber from being notified', () => {
    const store = createStore<{ n: number }>(() => ({ n: 0 }))
    const later = vi.fn()

    // Registration order matters: `App.tsx`'s own subscribers register once
    // at mount; `DockTransport`'s `useXRSession()` registers later, every
    // time player mode is entered - so it always lands AFTER these in
    // xrStore's real listener set. Mirrored here as "earlier" vs "later".
    store.subscribe(() => {
      throw new Error('boom - an unguarded subscriber')
    })
    store.subscribe(later)

    expect(() => store.setState({ n: 1 })).toThrow('boom - an unguarded subscriber')
    // The critical assertion: `later` - standing in for DockTransport's own
    // session-state sync - was never called for this notification, even
    // though it did nothing wrong itself.
    expect(later).not.toHaveBeenCalled()
  })
})

describe('guardXRStoreSubscriber', () => {
  it('runs the callback normally when it does not throw', () => {
    const run = vi.fn()
    guardXRStoreSubscriber('test', run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('swallows a thrown exception rather than letting it propagate', () => {
    const run = () => {
      throw new Error('boom')
    }
    expect(() => guardXRStoreSubscriber('test', run)).not.toThrow()
  })

  it('logs the error via console.error, with the label, rather than staying fully silent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error('boom')
      guardXRStoreSubscriber('tour gate', () => {
        throw error
      })
      expect(spy).toHaveBeenCalledTimes(1)
      const [message, loggedError] = spy.mock.calls[0]!
      expect(String(message)).toContain('tour gate')
      expect(loggedError).toBe(error)
    } finally {
      spy.mockRestore()
    }
  })

  it('closes the hazard: a guarded subscriber that throws no longer blocks LATER subscribers', () => {
    const store = createStore<{ n: number }>(() => ({ n: 0 }))
    const later = vi.fn()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      store.subscribe(() => {
        guardXRStoreSubscriber('tour gate', () => {
          throw new Error('boom - now guarded')
        })
      })
      store.subscribe(later)

      // The key difference from the "unwrapped" describe block above:
      // setState itself no longer throws...
      expect(() => store.setState({ n: 1 })).not.toThrow()
      // ...and the later subscriber - standing in for DockTransport's
      // `useXRSession()` - DOES get notified.
      expect(later).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
