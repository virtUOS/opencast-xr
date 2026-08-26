import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_PREFS_KEY,
  DEFAULT_BACKGROUND_PREFS,
  readBackgroundPrefs,
  writeBackgroundPrefs,
  type BackgroundPrefsStorage,
} from './backgroundPrefs'

/** An in-memory `Storage`, so these tests need no DOM and cannot leak into each other. */
function fakeStorage(initial: Record<string, string> = {}): BackgroundPrefsStorage & { items: Record<string, string> } {
  const items = { ...initial }
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value
    },
  }
}

function throwingStorage(): BackgroundPrefsStorage {
  return {
    getItem() {
      throw new DOMException('denied', 'SecurityError')
    },
    setItem() {
      // Safari's private mode throws on the very first write.
      throw new DOMException('quota', 'QuotaExceededError')
    },
  }
}

describe('readBackgroundPrefs', () => {
  it('answers the default (black) when nothing has been stored', () => {
    expect(readBackgroundPrefs(fakeStorage())).toEqual(DEFAULT_BACKGROUND_PREFS)
    expect(DEFAULT_BACKGROUND_PREFS).toEqual({ background: 'black' })
  })

  it('answers the default with no storage at all', () => {
    // A non-DOM environment, or a browser that refuses to hand localStorage out.
    expect(readBackgroundPrefs(null)).toEqual(DEFAULT_BACKGROUND_PREFS)
    expect(readBackgroundPrefs(undefined)).toEqual(DEFAULT_BACKGROUND_PREFS)
  })

  it('round-trips what was written', () => {
    const storage = fakeStorage()
    writeBackgroundPrefs(storage, { background: 'passthrough' })
    expect(readBackgroundPrefs(storage)).toEqual({ background: 'passthrough' })
  })

  it('survives every shape of junk in the key', () => {
    for (const raw of ['', 'not json', 'null', '42', '"a string"', '[]', '{"background":"purple"}', '{}']) {
      const prefs = readBackgroundPrefs(fakeStorage({ [BACKGROUND_PREFS_KEY]: raw }))
      expect(prefs.background === 'black' || prefs.background === 'passthrough').toBe(true)
    }
  })

  it('falls back to the default for a value from a build that no longer recognises it', () => {
    const storage = fakeStorage({ [BACKGROUND_PREFS_KEY]: JSON.stringify({ background: 'chroma-green' }) })
    expect(readBackgroundPrefs(storage)).toEqual({ background: 'black' })
  })

  it('never throws, even when the storage itself does', () => {
    expect(() => readBackgroundPrefs(throwingStorage())).not.toThrow()
    expect(readBackgroundPrefs(throwingStorage())).toEqual(DEFAULT_BACKGROUND_PREFS)
  })
})

describe('writeBackgroundPrefs', () => {
  it('stores one JSON object under one namespaced key, in the caption prefs\' key family', () => {
    const storage = fakeStorage()
    writeBackgroundPrefs(storage, { background: 'passthrough' })
    expect(Object.keys(storage.items)).toEqual([BACKGROUND_PREFS_KEY])
    expect(JSON.parse(storage.items[BACKGROUND_PREFS_KEY]!)).toEqual({ background: 'passthrough' })
    expect(BACKGROUND_PREFS_KEY.startsWith('opencastxr.player.')).toBe(true)
  })

  it('never throws - a full or forbidden storage is not the user\'s problem', () => {
    expect(() => writeBackgroundPrefs(throwingStorage(), { background: 'passthrough' })).not.toThrow()
    expect(() => writeBackgroundPrefs(null, { background: 'passthrough' })).not.toThrow()
  })
})
