import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server.js'
import { createDailyDedup } from '../src/dedup.js'
import { createFixtureCountryLookup } from '../src/geo.js'
import { emptyState } from '../src/aggregate.js'
import { loadState } from '../src/store.js'

let dir
let server
let baseUrl
let currentApp

async function startServer({ fakeGeo = {}, now = () => new Date('2026-08-28T12:00:00Z'), trustProxy = false } = {}) {
  const stateFilePath = path.join(dir, 'state.json')
  const app = createApp({
    initialState: emptyState(),
    countryLookup: createFixtureCountryLookup(fakeGeo),
    dedup: createDailyDedup({ now }),
    stateFilePath,
    trustProxy,
    now,
  })
  currentApp = app
  server = createServer(app.requestListener)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  baseUrl = `http://127.0.0.1:${port}`
  return { app, stateFilePath }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'counter-http-test-'))
})

afterEach(async () => {
  // Every hit schedules its disk write fire-and-forget (the client response
  // doesn't wait on it — see server.js's `scheduleSave`), so without this the
  // temp dir can get rm'd while a write is still landing in it, which races
  // ENOTEMPTY on some platforms. Flushing first makes teardown deterministic.
  await currentApp?.flush()
  await new Promise((resolve) => server?.close(resolve))
  await rm(dir, { recursive: true, force: true })
  currentApp = undefined
})

describe('the counter HTTP surface', () => {
  it('POST /api/hit accepts a valid hit and responds 204', async () => {
    await startServer({ fakeGeo: { '127.0.0.1': 'DE' } })
    const res = await fetch(`${baseUrl}/api/hit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'page' }),
    })
    expect(res.status).toBe(204)
  })

  it('POST /api/hit rejects an invalid payload with 400', async () => {
    await startServer()
    const res = await fetch(`${baseUrl}/api/hit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'not-a-real-kind' }),
    })
    expect(res.status).toBe(400)
  })

  it('GET /stats.json reflects a prior hit, aggregated by country', async () => {
    await startServer({ fakeGeo: { '127.0.0.1': 'DE' } })
    await fetch(`${baseUrl}/api/hit`, { method: 'POST', body: JSON.stringify({ kind: 'page' }) })
    await fetch(`${baseUrl}/api/hit`, { method: 'POST', body: JSON.stringify({ kind: 'vr' }) })

    const statsRes = await fetch(`${baseUrl}/stats.json`)
    expect(statsRes.status).toBe(200)
    const stats = await statsRes.json()
    expect(stats.days['2026-08-28'].countries.DE).toEqual({
      pageHits: 1,
      uniqueVisitors: 1, // only the FIRST hit today from this IP counts as unique
      vrSessions: 1,
      arSessions: 0,
    })
  })

  it('GET /stats renders self-contained HTML including the numbers just recorded', async () => {
    await startServer({ fakeGeo: { '127.0.0.1': 'FR' } })
    await fetch(`${baseUrl}/api/hit`, { method: 'POST', body: JSON.stringify({ kind: 'page' }) })
    const res = await fetch(`${baseUrl}/stats`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Frankreich (FR)')
  })

  it('dedups two hits from the same fake IP on the same day: only the first bumps uniqueVisitors', async () => {
    await startServer({ fakeGeo: { '127.0.0.1': 'DE' } })
    await fetch(`${baseUrl}/api/hit`, { method: 'POST', body: JSON.stringify({ kind: 'page' }) })
    await fetch(`${baseUrl}/api/hit`, { method: 'POST', body: JSON.stringify({ kind: 'page' }) })
    const stats = await (await fetch(`${baseUrl}/stats.json`)).json()
    expect(stats.days['2026-08-28'].countries.DE).toEqual({
      pageHits: 2,
      uniqueVisitors: 1,
      vrSessions: 0,
      arSessions: 0,
    })
  })

  it('an unrecognized route 404s', async () => {
    await startServer()
    const res = await fetch(`${baseUrl}/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('persists the aggregate to the state file on disk (atomic write)', async () => {
    const { app, stateFilePath } = await startServer({ fakeGeo: { '127.0.0.1': 'DE' } })
    await fetch(`${baseUrl}/api/hit`, { method: 'POST', body: JSON.stringify({ kind: 'page' }) })
    await app.flush()
    const onDisk = await loadState(stateFilePath)
    expect(onDisk.days['2026-08-28'].countries.DE.pageHits).toBe(1)
  })

  it('rejects an oversized body with 413', async () => {
    await startServer()
    const res = await fetch(`${baseUrl}/api/hit`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'page', padding: 'x'.repeat(10_000) }),
    })
    expect(res.status).toBe(413)
  })
})
