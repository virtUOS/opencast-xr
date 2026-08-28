import { describe, expect, it, vi } from 'vitest'
import { createTelemetryState, hitPayload, reportHit, shouldSendHit } from './telemetry'

describe('hitPayload', () => {
  it('is exactly {"kind": ...} - matches the counter service strict schema', () => {
    expect(hitPayload('page')).toBe('{"kind":"page"}')
    expect(hitPayload('vr')).toBe('{"kind":"vr"}')
    expect(hitPayload('ar')).toBe('{"kind":"ar"}')
  })
})

describe('shouldSendHit', () => {
  it('is true the first time a kind is asked about', () => {
    const state = createTelemetryState()
    expect(shouldSendHit(state, 'page')).toBe(true)
  })

  it('is false on every subsequent ask for the same kind', () => {
    const state = createTelemetryState()
    shouldSendHit(state, 'vr')
    expect(shouldSendHit(state, 'vr')).toBe(false)
    expect(shouldSendHit(state, 'vr')).toBe(false)
  })

  it('tracks each kind independently - sending "vr" does not consume "ar" or "page"', () => {
    const state = createTelemetryState()
    expect(shouldSendHit(state, 'vr')).toBe(true)
    expect(shouldSendHit(state, 'ar')).toBe(true)
    expect(shouldSendHit(state, 'page')).toBe(true)
  })
})

describe('reportHit', () => {
  it('calls the transport with the hit payload the first time', () => {
    const state = createTelemetryState()
    const transport = vi.fn()
    reportHit(state, 'page', transport)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith('{"kind":"page"}')
  })

  it('does not call the transport again for the same kind - re-entering VR in one page load counts once', () => {
    const state = createTelemetryState()
    const transport = vi.fn()
    reportHit(state, 'vr', transport)
    reportHit(state, 'vr', transport)
    reportHit(state, 'vr', transport)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('still sends AR separately from VR in the same page load', () => {
    const state = createTelemetryState()
    const transport = vi.fn()
    reportHit(state, 'vr', transport)
    reportHit(state, 'ar', transport)
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport).toHaveBeenNthCalledWith(1, '{"kind":"vr"}')
    expect(transport).toHaveBeenNthCalledWith(2, '{"kind":"ar"}')
  })

  it('never throws when the transport throws synchronously - a missing counter must not affect the player', () => {
    const state = createTelemetryState()
    const throwingTransport = vi.fn(() => {
      throw new Error('network is unreachable')
    })
    expect(() => reportHit(state, 'page', throwingTransport)).not.toThrow()
  })

  // Async rejections are the transport's OWN responsibility to swallow - the
  // `HitTransport` contract returns `void`, not a promise `reportHit` could
  // await, so it can only guard against a SYNCHRONOUS throw. The shipped
  // `defaultTransport` (telemetry.ts) already does this itself via
  // `fetch(...).catch(() => {})` - this is what that inner catch is for.
})
