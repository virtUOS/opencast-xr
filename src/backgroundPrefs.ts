import { DEFAULT_BACKGROUND, type BackgroundMode } from './backgroundMode'

/**
 * The background choice - "schwarz" or "durchsichtig" - survives a reload,
 * for the same reason the caption settings do (see `captionPrefs.ts`'s doc
 * comment): it is a preference the user set deliberately once, at the start
 * overlay, and a control that resets to the default every visit is one that
 * has to be re-found and re-pressed every time. Same storage contract as
 * `captionPrefs.ts` - a `Storage`-shaped parameter rather than reaching for
 * `window.localStorage` directly, total read/write functions that never
 * throw, and a corrupt or missing value falling back to the default rather
 * than propagating.
 *
 * A separate module and a separate key rather than folding into
 * `CaptionPrefs`: this is a WebXR entry decision, made once before any
 * session exists, not an accessibility setting applied to a running player -
 * different lifetime, different reader (`App.tsx`'s start overlay, not
 * `SubtitleHud`/`DockTransport`). Keeping them apart means a future change to
 * one's shape never has to reason about the other's fields.
 */
export interface BackgroundPrefs {
  background: BackgroundMode
}

/** Namespaced into the same key family as `CAPTION_PREFS_KEY`, so both are recognisable as this app's. */
export const BACKGROUND_PREFS_KEY = 'opencastxr.player.background'

/** The subset of `Storage` this module uses - `localStorage` satisfies it, and so does a two-line fake. */
export interface BackgroundPrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_BACKGROUND_PREFS: BackgroundPrefs = {
  background: DEFAULT_BACKGROUND,
}

/**
 * `window.localStorage`, or `null` where it is unavailable or refuses to be
 * touched. Never throws - see `captionPrefsStorage`'s doc comment for why
 * even reading the PROPERTY can throw in some restricted contexts.
 */
export function backgroundPrefsStorage(): BackgroundPrefsStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** `true` for any value this build recognises; guards a corrupt or older/newer stored string. */
function isBackgroundMode(value: unknown): value is BackgroundMode {
  return value === 'black' || value === 'passthrough'
}

/**
 * The stored background preference, or the default for anything missing,
 * corrupt, unrecognised, or behind a throwing storage. Total, like
 * `readCaptionPrefs`: a bad value here must land on `'black'` (today's
 * behaviour) rather than on an exception or an unrecognised session mode
 * reaching `xrStore.enterXR`.
 */
export function readBackgroundPrefs(storage: BackgroundPrefsStorage | null | undefined): BackgroundPrefs {
  if (!storage) return { ...DEFAULT_BACKGROUND_PREFS }
  let raw: string | null
  try {
    raw = storage.getItem(BACKGROUND_PREFS_KEY)
  } catch {
    return { ...DEFAULT_BACKGROUND_PREFS }
  }
  if (raw == null) return { ...DEFAULT_BACKGROUND_PREFS }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_BACKGROUND_PREFS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_BACKGROUND_PREFS }

  const record = parsed as Record<string, unknown>
  return {
    background: isBackgroundMode(record.background) ? record.background : DEFAULT_BACKGROUND,
  }
}

/**
 * Stores the background preference. A storage that is absent or throws (a
 * full quota, Safari's private mode) is not an error the user should ever
 * hear about: the choice still applies for this visit, it just will not be
 * remembered next time.
 */
export function writeBackgroundPrefs(
  storage: BackgroundPrefsStorage | null | undefined,
  prefs: BackgroundPrefs,
): void {
  if (!storage) return
  try {
    storage.setItem(
      BACKGROUND_PREFS_KEY,
      JSON.stringify({
        background: isBackgroundMode(prefs.background) ? prefs.background : DEFAULT_BACKGROUND,
      }),
    )
  } catch {
    // Deliberately silent - see the doc comment.
  }
}
