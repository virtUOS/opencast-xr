import { describe, expect, it } from 'vitest'
import { emptyState, recordHit } from '../src/aggregate.js'
import { renderStatsHtml, renderStatsJson } from '../src/render.js'

describe('renderStatsHtml', () => {
  it('is self-contained (no external assets)', () => {
    const html = renderStatsHtml(emptyState(), { now: () => new Date('2026-08-28T12:00:00Z') })
    expect(html).not.toMatch(/https?:\/\/(?!db-ip\.com|creativecommons\.org)/)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<link')
  })

  it('carries the db-ip CC-BY attribution', () => {
    const html = renderStatsHtml(emptyState(), { now: () => new Date('2026-08-28T12:00:00Z') })
    expect(html).toContain('DB-IP')
    expect(html).toContain('CC BY 4.0')
  })

  it('renders the totals and per-day/per-country data it was given', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'vr', isFirstVisitorToday: false })
    const html = renderStatsHtml(state, { now: () => new Date('2026-08-28T12:00:00Z') })
    expect(html).toContain('Deutschland (DE)')
    expect(html).toContain('2026-08-28')
  })

  it('escapes HTML-significant characters in a country code (defense in depth)', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: '<script>', kind: 'page', isFirstVisitorToday: true })
    const html = renderStatsHtml(state, { now: () => new Date('2026-08-28T12:00:00Z') })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('renderStatsJson', () => {
  it('returns the raw aggregate plus a generation timestamp', () => {
    let state = emptyState()
    state = recordHit(state, { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    const json = renderStatsJson(state, { now: () => new Date('2026-08-28T12:00:00Z') })
    expect(json.generatedAt).toBe('2026-08-28T12:00:00.000Z')
    expect(json.days['2026-08-28'].countries.DE.pageHits).toBe(1)
  })
})
