import { describe, expect, it } from 'vitest'
import {
  CAPTION_PREFS_KEY,
  DEFAULT_CAPTION_PREFS,
  readCaptionPrefs,
  writeCaptionPrefs,
  type CaptionPrefsStorage,
} from './captionPrefs'
import {
  DEFAULT_CAPTION_OFFSET_DEG,
  DEFAULT_CAPTION_SCALE,
  MAX_CAPTION_OFFSET_DEG,
  MAX_CAPTION_SCALE,
  MIN_CAPTION_SCALE,
} from './captionScale'

/** An in-memory `Storage`, so these tests need no DOM and cannot leak into each other. */
function fakeStorage(initial: Record<string, string> = {}): CaptionPrefsStorage & { items: Record<string, string> } {
  const items = { ...initial }
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value
    },
  }
}

function throwingStorage(): CaptionPrefsStorage {
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

describe('readCaptionPrefs', () => {
  it('answers the defaults when nothing has been stored', () => {
    expect(readCaptionPrefs(fakeStorage())).toEqual(DEFAULT_CAPTION_PREFS)
    expect(DEFAULT_CAPTION_PREFS).toEqual({
      scale: DEFAULT_CAPTION_SCALE,
      offsetDeg: DEFAULT_CAPTION_OFFSET_DEG,
    })
  })

  it('answers the defaults with no storage at all', () => {
    // A non-DOM environment, or a browser that refuses to hand localStorage out.
    expect(readCaptionPrefs(null)).toEqual(DEFAULT_CAPTION_PREFS)
    expect(readCaptionPrefs(undefined)).toEqual(DEFAULT_CAPTION_PREFS)
  })

  it('round-trips what was written', () => {
    const storage = fakeStorage()
    writeCaptionPrefs(storage, { scale: 0.2, offsetDeg: 6 })
    expect(readCaptionPrefs(storage)).toEqual({ scale: 0.2, offsetDeg: 6 })
  })

  it('clamps a value written by an older build into the current range', () => {
    // The ladder has already been retuned once (it used to top out at 0.32 with
    // a 0.24 default), so this is an expected input, not a corrupt one.
    const storage = fakeStorage({
      [CAPTION_PREFS_KEY]: JSON.stringify({ scale: 5, offsetDeg: 90 }),
    })
    expect(readCaptionPrefs(storage)).toEqual({
      scale: MAX_CAPTION_SCALE,
      offsetDeg: MAX_CAPTION_OFFSET_DEG,
    })

    const tiny = fakeStorage({ [CAPTION_PREFS_KEY]: JSON.stringify({ scale: 0.001, offsetDeg: 0 }) })
    expect(readCaptionPrefs(tiny).scale).toBe(MIN_CAPTION_SCALE)
  })

  it('survives every shape of junk in the key', () => {
    for (const raw of ['', 'not json', 'null', '42', '"a string"', '[]', '{"scale":"big"}', '{}']) {
      const prefs = readCaptionPrefs(fakeStorage({ [CAPTION_PREFS_KEY]: raw }))
      expect(Number.isFinite(prefs.scale)).toBe(true)
      expect(Number.isFinite(prefs.offsetDeg)).toBe(true)
      expect(prefs.scale).toBeGreaterThanOrEqual(MIN_CAPTION_SCALE)
    }
  })

  it('takes the half it understands from a partial object', () => {
    const storage = fakeStorage({ [CAPTION_PREFS_KEY]: JSON.stringify({ scale: 0.2 }) })
    expect(readCaptionPrefs(storage)).toEqual({ scale: 0.2, offsetDeg: DEFAULT_CAPTION_OFFSET_DEG })
  })

  it('never throws, even when the storage itself does', () => {
    expect(() => readCaptionPrefs(throwingStorage())).not.toThrow()
    expect(readCaptionPrefs(throwingStorage())).toEqual(DEFAULT_CAPTION_PREFS)
  })
})

describe('writeCaptionPrefs', () => {
  it('stores one JSON object under one namespaced key', () => {
    const storage = fakeStorage()
    writeCaptionPrefs(storage, { scale: 0.2, offsetDeg: -3 })
    expect(Object.keys(storage.items)).toEqual([CAPTION_PREFS_KEY])
    expect(JSON.parse(storage.items[CAPTION_PREFS_KEY]!)).toEqual({ scale: 0.2, offsetDeg: -3 })
  })

  it('clamps on the way out, so nothing unreadable can ever be stored', () => {
    const storage = fakeStorage()
    writeCaptionPrefs(storage, { scale: Number.NaN, offsetDeg: 999 })
    expect(readCaptionPrefs(storage)).toEqual({
      scale: DEFAULT_CAPTION_SCALE,
      offsetDeg: MAX_CAPTION_OFFSET_DEG,
    })
  })

  it('never throws - a full or forbidden storage is not the user\'s problem', () => {
    expect(() => writeCaptionPrefs(throwingStorage(), { scale: 0.2, offsetDeg: 0 })).not.toThrow()
    expect(() => writeCaptionPrefs(null, { scale: 0.2, offsetDeg: 0 })).not.toThrow()
  })
})
