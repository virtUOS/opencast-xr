/**
 * Whether the tutorial tour is switched on, as set on the start overlay -
 * survives a reload, same defensive contract as `captionPrefs.ts` and
 * `backgroundPrefs.ts` (a `Storage`-shaped parameter, total read/write
 * functions that never throw, a corrupt or missing value falling back to the
 * default rather than propagating).
 *
 * ## Why the default is ON
 *
 * „Da ich die Anwendung auf einer Konferenz zeigen werde, will ich nicht die
 * ganze Zeit daneben stehen" - the tour exists so a conference visitor who has
 * never seen the app gets it explained without anyone standing next to the
 * headset. That only works if it is ON the first time anyone opens the app on
 * a machine that has never written this key before, which is exactly what
 * `DEFAULT_TUTORIAL_PREFS` being `{ enabled: true }` buys: nobody has to find
 * and flip a checkbox before the first visitor of the day puts the headset on.
 * Someone running the app for themselves, who already knows the controls, is
 * one click away from turning it off - and that choice then persists, exactly
 * like the caption and background preferences.
 *
 * ## Why this is a separate module and key, not folded into another prefs file
 *
 * Same reasoning as `backgroundPrefs.ts`'s own doc comment: this is a start
 * overlay decision (`App.tsx`, not `DockTransport`/`SubtitleHud`), made before
 * a session exists, with its own single field - keeping it apart means a
 * future change to the caption or background prefs' shape never has to reason
 * about this one.
 *
 * Completing or skipping a tour never touches this preference - only the
 * start overlay's own checkbox does. See `windows/tourState.ts` and
 * `windows/tourGate.ts` for the tour itself; this module only ever answers
 * "is it switched on".
 */
export interface TutorialPrefs {
  enabled: boolean
}

/** Namespaced into the same key family as `CAPTION_PREFS_KEY`/`BACKGROUND_PREFS_KEY`. */
export const TUTORIAL_PREFS_KEY = 'opencastxr.player.tutorial'

/** The subset of `Storage` this module uses - `localStorage` satisfies it, and so does a two-line fake. */
export interface TutorialPrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_TUTORIAL_PREFS: TutorialPrefs = {
  enabled: true,
}

/**
 * `window.localStorage`, or `null` where it is unavailable or refuses to be
 * touched. Never throws - see `captionPrefsStorage`'s doc comment for why
 * even reading the PROPERTY can throw in some restricted contexts.
 */
export function tutorialPrefsStorage(): TutorialPrefsStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * The stored tutorial preference, or the default (ON) for anything missing,
 * corrupt, unrecognised, or behind a throwing storage. Total, like
 * `readBackgroundPrefs`: a bad value here must land on the default rather
 * than on an exception or a non-boolean reaching the start overlay's
 * checkbox.
 */
export function readTutorialPrefs(storage: TutorialPrefsStorage | null | undefined): TutorialPrefs {
  if (!storage) return { ...DEFAULT_TUTORIAL_PREFS }
  let raw: string | null
  try {
    raw = storage.getItem(TUTORIAL_PREFS_KEY)
  } catch {
    return { ...DEFAULT_TUTORIAL_PREFS }
  }
  if (raw == null) return { ...DEFAULT_TUTORIAL_PREFS }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_TUTORIAL_PREFS }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_TUTORIAL_PREFS }

  const record = parsed as Record<string, unknown>
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_TUTORIAL_PREFS.enabled,
  }
}

/**
 * Stores the tutorial preference. A storage that is absent or throws (a full
 * quota, Safari's private mode) is not an error the user should ever hear
 * about: the choice still applies for this visit, it just will not be
 * remembered next time.
 */
export function writeTutorialPrefs(
  storage: TutorialPrefsStorage | null | undefined,
  prefs: TutorialPrefs,
): void {
  if (!storage) return
  try {
    storage.setItem(
      TUTORIAL_PREFS_KEY,
      JSON.stringify({
        enabled: typeof prefs.enabled === 'boolean' ? prefs.enabled : DEFAULT_TUTORIAL_PREFS.enabled,
      }),
    )
  } catch {
    // Deliberately silent - see the doc comment.
  }
}
