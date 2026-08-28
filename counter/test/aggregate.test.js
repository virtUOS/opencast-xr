import { describe, expect, it } from 'vitest'
import { countryTotals, emptyState, grandTotals, lastNDays, recordHit } from '../src/aggregate.js'

describe('recordHit', () => {
  it('creates a day/country bucket from scratch', () => {
    const state = recordHit(emptyState(), { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    expect(state.days['2026-08-28'].countries.DE).toEqual({ pageHits: 1, uniqueVisitors: 1, vrSessions: 0, arSessions: 0 })
  })

  it('accumulates repeated hits for the same day/country', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'vr', isFirstVisitorToday: false })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: false })
    expect(state.days['2026-08-28'].countries.DE).toEqual({ pageHits: 2, uniqueVisitors: 1, vrSessions: 1, arSessions: 0 })
  })

  it('does not mutate the input state (pure)', () => {
    const before = emptyState()
    const snapshot = JSON.stringify(before)
    recordHit(before, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('buckets a missing/falsy country under ZZ', () => {
    const state = recordHit(emptyState(), { dateKey: '2026-08-28', country: null, kind: 'page', isFirstVisitorToday: true })
    expect(Object.keys(state.days['2026-08-28'].countries)).toEqual(['ZZ'])
  })

  it('keeps separate countries within the same day separate', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'FR', kind: 'page', isFirstVisitorToday: true })
    expect(state.days['2026-08-28'].countries.DE.pageHits).toBe(1)
    expect(state.days['2026-08-28'].countries.FR.pageHits).toBe(1)
  })

  it('increments ar for kind "ar" and nothing else', () => {
    const state = recordHit(emptyState(), { dateKey: '2026-08-28', country: 'DE', kind: 'ar', isFirstVisitorToday: false })
    expect(state.days['2026-08-28'].countries.DE).toEqual({ pageHits: 0, uniqueVisitors: 0, vrSessions: 0, arSessions: 1 })
  })
})

describe('grandTotals', () => {
  it('sums across days and countries', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-27', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'FR', kind: 'vr', isFirstVisitorToday: true })
    expect(grandTotals(state)).toEqual({ pageHits: 1, uniqueVisitors: 2, vrSessions: 1, arSessions: 0 })
  })

  it('is all-zero for an empty state', () => {
    expect(grandTotals(emptyState())).toEqual({ pageHits: 0, uniqueVisitors: 0, vrSessions: 0, arSessions: 0 })
  })
})

describe('lastNDays', () => {
  it('zero-fills missing days and orders oldest-first', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    const days = lastNDays(state, '2026-08-28', 3)
    expect(days.map((d) => d.dateKey)).toEqual(['2026-08-26', '2026-08-27', '2026-08-28'])
    expect(days[0]).toEqual({ dateKey: '2026-08-26', pageHits: 0, uniqueVisitors: 0, vrSessions: 0, arSessions: 0 })
    expect(days[2].pageHits).toBe(1)
  })

  it('sums across countries for a single day', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'FR', kind: 'page', isFirstVisitorToday: true })
    const [day] = lastNDays(state, '2026-08-28', 1)
    expect(day.pageHits).toBe(2)
  })
})

describe('countryTotals', () => {
  it('sums per country across days and sorts by descending page hits', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-27', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'FR', kind: 'page', isFirstVisitorToday: true })
    expect(countryTotals(state)).toEqual([
      { country: 'DE', pageHits: 2, uniqueVisitors: 2, vrSessions: 0, arSessions: 0 },
      { country: 'FR', pageHits: 1, uniqueVisitors: 1, vrSessions: 0, arSessions: 0 },
    ])
  })

  it('is empty for an empty state', () => {
    expect(countryTotals(emptyState())).toEqual([])
  })
})
