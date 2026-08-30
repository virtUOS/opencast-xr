import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TUTORIAL_PREFS,
  TUTORIAL_PREFS_KEY,
  readTutorialPrefs,
  writeTutorialPrefs,
  type TutorialPrefsStorage,
} from './tutorialPrefs'

/** An in-memory `Storage`, so these tests need no DOM and cannot leak into each other. */
function fakeStorage(initial: Record<string, string> = {}): TutorialPrefsStorage & { items: Record<string, string> } {
  const items = { ...initial }
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value
    },
  }
}

function throwingStorage(): TutorialPrefsStorage {
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

describe('readTutorialPrefs', () => {
  it('defaults to ON when nothing has been stored', () => {
    expect(readTutorialPrefs(fakeStorage())).toEqual(DEFAULT_TUTORIAL_PREFS)
    expect(DEFAULT_TUTORIAL_PREFS).toEqual({ enabled: true })
  })

  it('defaults to ON with no storage at all', () => {
    // A non-DOM environment, or a browser that refuses to hand localStorage out.
    expect(readTutorialPrefs(null)).toEqual(DEFAULT_TUTORIAL_PREFS)
    expect(readTutorialPrefs(undefined)).toEqual(DEFAULT_TUTORIAL_PREFS)
  })

  it('round-trips what was written, in both directions', () => {
    const storage = fakeStorage()
    writeTutorialPrefs(storage, { enabled: false })
    expect(readTutorialPrefs(storage)).toEqual({ enabled: false })
    writeTutorialPrefs(storage, { enabled: true })
    expect(readTutorialPrefs(storage)).toEqual({ enabled: true })
  })

  it('survives every shape of junk in the key, always answering a boolean', () => {
    for (const raw of ['', 'not json', 'null', '42', '"a string"', '[]', '{"enabled":"yes"}', '{}']) {
      const prefs = readTutorialPrefs(fakeStorage({ [TUTORIAL_PREFS_KEY]: raw }))
      expect(typeof prefs.enabled).toBe('boolean')
    }
  })

  it('falls back to the default (ON) for anything that is not a real boolean', () => {
    const storage = fakeStorage({ [TUTORIAL_PREFS_KEY]: JSON.stringify({ enabled: 'off' }) })
    expect(readTutorialPrefs(storage)).toEqual({ enabled: true })
  })

  it('never throws, even when the storage itself does', () => {
    expect(() => readTutorialPrefs(throwingStorage())).not.toThrow()
    expect(readTutorialPrefs(throwingStorage())).toEqual(DEFAULT_TUTORIAL_PREFS)
  })
})

describe('writeTutorialPrefs', () => {
  it("stores one JSON object under one namespaced key, in the player prefs' key family", () => {
    const storage = fakeStorage()
    writeTutorialPrefs(storage, { enabled: false })
    expect(Object.keys(storage.items)).toEqual([TUTORIAL_PREFS_KEY])
    expect(JSON.parse(storage.items[TUTORIAL_PREFS_KEY]!)).toEqual({ enabled: false })
    expect(TUTORIAL_PREFS_KEY.startsWith('opencastxr.player.')).toBe(true)
  })

  it("never throws - a full or forbidden storage is not the user's problem", () => {
    expect(() => writeTutorialPrefs(throwingStorage(), { enabled: false })).not.toThrow()
    expect(() => writeTutorialPrefs(null, { enabled: false })).not.toThrow()
  })
})
