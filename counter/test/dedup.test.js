import { describe, expect, it } from 'vitest'
import { createDailyDedup } from '../src/dedup.js'

// A deterministic stand-in for crypto.randomBytes so salts (and thus the
// resulting hashes) are reproducible across runs without weakening what's
// under test (the dedup LOGIC, not HMAC/randomBytes themselves).
let counter = 0
function fakeRandomBytes(size) {
  counter += 1
  return Buffer.alloc(size, counter)
}

describe('createDailyDedup', () => {
  it('reports the first hit from an IP on a given day as first, the second as not', () => {
    const dedup = createDailyDedup({ now: () => new Date('2026-08-28T10:00:00Z'), randomBytes: fakeRandomBytes })
    const first = dedup.recordAndCheck('203.0.113.5')
    const second = dedup.recordAndCheck('203.0.113.5')
    expect(first).toEqual({ dateKey: '2026-08-28', isFirstToday: true })
    expect(second).toEqual({ dateKey: '2026-08-28', isFirstToday: false })
  })

  it('treats different IPs as distinct visitors on the same day', () => {
    const dedup = createDailyDedup({ now: () => new Date('2026-08-28T10:00:00Z'), randomBytes: fakeRandomBytes })
    expect(dedup.recordAndCheck('203.0.113.5').isFirstToday).toBe(true)
    expect(dedup.recordAndCheck('203.0.113.6').isFirstToday).toBe(true)
  })

  it('resets on a new UTC day, counting the same IP as first again', () => {
    let now = new Date('2026-08-28T23:59:00Z')
    const dedup = createDailyDedup({ now: () => now, randomBytes: fakeRandomBytes })
    expect(dedup.recordAndCheck('203.0.113.5').isFirstToday).toBe(true)
    expect(dedup.recordAndCheck('203.0.113.5').isFirstToday).toBe(false)
    now = new Date('2026-08-29T00:01:00Z')
    const next = dedup.recordAndCheck('203.0.113.5')
    expect(next).toEqual({ dateKey: '2026-08-29', isFirstToday: true })
  })

  it('never surfaces the raw IP in its return value', () => {
    const dedup = createDailyDedup({ now: () => new Date('2026-08-28T10:00:00Z'), randomBytes: fakeRandomBytes })
    const result = dedup.recordAndCheck('203.0.113.5')
    expect(JSON.stringify(result)).not.toContain('203.0.113.5')
  })

  it('dateKeyFor returns a UTC yyyy-mm-dd string', () => {
    const dedup = createDailyDedup()
    expect(dedup.dateKeyFor(new Date('2026-01-05T23:30:00Z'))).toBe('2026-01-05')
  })
})
