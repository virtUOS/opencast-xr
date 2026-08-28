import { describe, expect, it } from 'vitest'
import { MAX_HIT_BODY_BYTES, parseHitPayload } from '../src/validate.js'

describe('parseHitPayload', () => {
  it('accepts each valid kind', () => {
    expect(parseHitPayload('{"kind":"page"}')).toEqual({ ok: true, kind: 'page' })
    expect(parseHitPayload('{"kind":"vr"}')).toEqual({ ok: true, kind: 'vr' })
    expect(parseHitPayload('{"kind":"ar"}')).toEqual({ ok: true, kind: 'ar' })
  })

  it('rejects an empty body', () => {
    expect(parseHitPayload('').ok).toBe(false)
  })

  it('rejects invalid JSON', () => {
    expect(parseHitPayload('{not json').ok).toBe(false)
  })

  it('rejects a JSON array', () => {
    expect(parseHitPayload('["page"]').ok).toBe(false)
  })

  it('rejects null', () => {
    expect(parseHitPayload('null').ok).toBe(false)
  })

  it('rejects an unknown kind', () => {
    expect(parseHitPayload('{"kind":"laptop"}').ok).toBe(false)
  })

  it('rejects extra fields even alongside a valid kind', () => {
    expect(parseHitPayload('{"kind":"page","ip":"1.2.3.4"}').ok).toBe(false)
  })

  it('rejects a non-string kind', () => {
    expect(parseHitPayload('{"kind":1}').ok).toBe(false)
  })

  it('rejects a body over the size cap', () => {
    const huge = `{"kind":"page","padding":"${'x'.repeat(MAX_HIT_BODY_BYTES)}"}`
    const result = parseHitPayload(huge)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/too large/)
  })
})
