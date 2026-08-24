import {
  DEFAULT_CAPTION_OFFSET_DEG,
  DEFAULT_CAPTION_SCALE,
  clampCaptionOffset,
  clampCaptionScale,
} from './captionScale'

/**
 * The caption settings that survive a reload: how big the subtitles are and
 * where they sit.
 *
 * ## Why these two, and nothing else
 *
 * They are ACCESSIBILITY settings, not view state. Someone who needs larger
 * subtitles needs them larger in every session, and a control that has to be
 * re-found and re-pressed on every reload is a control that will be pressed
 * once and then endured. Everything else the player holds (volume, mute, which
 * windows are open, the open recording) is either per-session by nature or
 * belongs to a layout, and none of it is re-derived here.
 *
 * ## Why the storage is a parameter
 *
 * `localStorage` is not always there and not always safe to touch: it is absent
 * in a non-DOM test environment, and BOTH `getItem` and `setItem` can throw
 * outright in a privacy-restricted browser context (a `SecurityError` in some
 * cross-origin iframes, a `QuotaExceededError` in Safari's private mode - which
 * throws on the very first write). Passing the store in makes every one of
 * those a caller's decision and makes this module testable without a DOM;
 * `captionPrefsStorage()` is the one place that does the `window` lookup, and
 * it never throws either.
 *
 * Both directions are total functions: a missing key, a corrupt value, a
 * partial object, a hostile string and a throwing storage all produce the
 * defaults rather than an exception or a `NaN` reaching the HUD.
 */
export interface CaptionPrefs {
  scale: number
  offsetDeg: number
}

/** Namespaced, so it cannot collide with anything else served from the same origin. */
export const CAPTION_PREFS_KEY = 'opencastxr.player.caption'

/** The subset of `Storage` this module uses - `localStorage` satisfies it, and so does a two-line fake. */
export interface CaptionPrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_CAPTION_PREFS: CaptionPrefs = {
  scale: DEFAULT_CAPTION_SCALE,
  offsetDeg: DEFAULT_CAPTION_OFFSET_DEG,
}

/**
 * `window.localStorage`, or `null` where it is unavailable or refuses to be
 * touched. Never throws.
 */
export function captionPrefsStorage(): CaptionPrefsStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Accessing the PROPERTY itself throws in some restricted contexts.
    return null
  }
}

/**
 * The stored caption preferences, clamped into the ranges the current build
 * accepts, with anything missing or unusable falling back to the default.
 *
 * The clamp is the point of the round trip, not a formality: the accepted range
 * has already been retuned once (the ladder used to start at 0.18 and the
 * default was 0.24), so a value written by an older build is an ordinary,
 * expected input - and it must land somewhere legible instead of being either
 * rejected or applied out of range.
 */
export function readCaptionPrefs(storage: CaptionPrefsStorage | null | undefined): CaptionPrefs {
  if (!storage) return { ...DEFAULT_CAPTION_PREFS }
  let raw: string | null
  try {
    raw = storage.getItem(CAPTION_PREFS_KEY)
  } catch {
    return { ...DEFAULT_CAPTION_PREFS }
  }
  if (raw == null) return { ...DEFAULT_CAPTION_PREFS }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_CAPTION_PREFS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_CAPTION_PREFS }

  const record = parsed as Record<string, unknown>
  return {
    // `clampCaptionScale`/`clampCaptionOffset` both answer the default for a
    // non-finite input, so a string, a null or a missing field all land there
    // without a separate type check per field.
    scale: clampCaptionScale(toNumber(record.scale)),
    offsetDeg: clampCaptionOffset(toNumber(record.offsetDeg)),
  }
}

/**
 * Stores the caption preferences. A storage that is absent or throws (a full
 * quota, Safari's private mode) is not an error the user should ever hear
 * about: the setting still applies for this session, it just will not be there
 * next time.
 */
export function writeCaptionPrefs(
  storage: CaptionPrefsStorage | null | undefined,
  prefs: CaptionPrefs,
): void {
  if (!storage) return
  try {
    storage.setItem(
      CAPTION_PREFS_KEY,
      // Clamped on the way OUT too, so a stored value can never be one this
      // build would refuse to read back.
      JSON.stringify({
        scale: clampCaptionScale(prefs.scale),
        offsetDeg: clampCaptionOffset(prefs.offsetDeg),
      }),
    )
  } catch {
    // Deliberately silent - see the doc comment.
  }
}

/** A finite number, or `NaN` for anything that is not one (which both clamps read as "use the default"). */
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}
