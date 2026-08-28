import { describe, expect, it, vi } from 'vitest'
import { createFixtureCountryLookup, createMmdbCountryLookup } from '../src/geo.js'

describe('createFixtureCountryLookup', () => {
  it('resolves the mapped country for a known IP', async () => {
    const lookup = createFixtureCountryLookup({ '1.2.3.4': 'DE' })
    await expect(lookup('1.2.3.4')).resolves.toBe('DE')
  })

  it('resolves null for an IP not in the fixture map', async () => {
    const lookup = createFixtureCountryLookup({ '1.2.3.4': 'DE' })
    await expect(lookup('9.9.9.9')).resolves.toBeNull()
  })
})

describe('createMmdbCountryLookup', () => {
  // Deliberately NOT testing against a real db-ip .mmdb file (not checked
  // into this repo, per the design note) — only that a missing/unopenable
  // database degrades to "unknown" instead of throwing or crashing the
  // request handler.
  it('degrades to null (unknown) when the mmdb file cannot be opened, without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lookup = createMmdbCountryLookup('/nonexistent/path/to/dbip-country-lite.mmdb')
    await expect(lookup('1.2.3.4')).resolves.toBeNull()
    // A second call reuses the same (failed) reader promise rather than
    // retrying the filesystem/parse on every request.
    await expect(lookup('5.6.7.8')).resolves.toBeNull()
    warnSpy.mockRestore()
  })
})
