import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyState, recordHit } from '../src/aggregate.js'
import { loadState, saveStateAtomic } from '../src/store.js'

let dir

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'counter-store-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadState / saveStateAtomic', () => {
  it('round-trips a state through disk', async () => {
    const file = path.join(dir, 'nested', 'state.json')
    const state = recordHit(emptyState(), { dateKey: '2026-08-28', country: 'DE', kind: 'page', isFirstVisitorToday: true })
    await saveStateAtomic(file, state)
    const loaded = await loadState(file)
    expect(loaded).toEqual(state)
  })

  it('creates the parent directory if missing', async () => {
    const file = path.join(dir, 'a', 'b', 'c', 'state.json')
    await saveStateAtomic(file, emptyState())
    const loaded = await loadState(file)
    expect(loaded).toEqual(emptyState())
  })

  it('returns an empty state when the file does not exist', async () => {
    const loaded = await loadState(path.join(dir, 'missing.json'))
    expect(loaded).toEqual(emptyState())
  })

  it('falls back to an empty state on corrupt JSON rather than throwing', async () => {
    const file = path.join(dir, 'corrupt.json')
    const fs = await import('node:fs/promises')
    await fs.writeFile(file, '{not valid json', 'utf8')
    const loaded = await loadState(file)
    expect(loaded).toEqual(emptyState())
  })

  it('leaves no temp file behind after a successful save', async () => {
    const file = path.join(dir, 'state.json')
    await saveStateAtomic(file, emptyState())
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['state.json'])
  })
})
