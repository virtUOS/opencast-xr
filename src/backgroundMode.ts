/**
 * The player's background choice — "schwarz" or "durchsichtig" — and the one
 * piece of WebXR plumbing that choice implies: which session mode to enter.
 *
 * ## Why this exists at all
 *
 * `apps/demo/src/backgroundMode.ts` is the reference for this: same
 * reasoning (background is a session-mode property, not a scene property —
 * see that file's doc comment for the full `environmentBlendMode` story),
 * same two-value type, same idea that a set scene background paints over the
 * passthrough camera feed.
 *
 * ## In-session switching (sphere-shell 0.3.1+)
 *
 * Until sphere-shell 0.3.1 this was scoped to the start overlay ONLY:
 * 0.3.0's dock „..." menu was a closed set (`DockMenuItemId = 'arrange' |
 * 'recenter' | 'curved'`, no app-supplied rows). 0.3.1 added
 * `WindowShellProps.dockMenuItems` (`AppDockMenuItem[]`), so `App.tsx` now
 * adds a background row to that menu too — see its doc comment for the
 * session-restart mechanics (why the row ENDS the session rather than
 * chaining `session.end()` into `enterAR()`/`enterVR()` directly) and
 * `otherBackground`/`backgroundToggleAvailable`/`backgroundToggleLabel`
 * below for the pure decisions behind that row. Outside a session (browse
 * mode, or the start overlay's own radios) the row still works — it just has
 * no session to end, so it only flips the persisted preference.
 */
export type BackgroundMode = 'black' | 'passthrough'

export const DEFAULT_BACKGROUND: BackgroundMode = 'black'

/** Which immersive session mode can actually deliver a given background. */
export function sessionModeFor(background: BackgroundMode): XRSessionMode {
  return background === 'passthrough' ? 'immersive-ar' : 'immersive-vr'
}

/**
 * The scene background colour for a given choice, or `null` for "render no
 * background at all" (transparent canvas in the browser, passthrough in AR).
 *
 * Matches the player's existing near-black `#101014` (previously hard-coded
 * in `App.tsx`'s `<color attach="background">`), so choosing "Schwarz" - the
 * default - changes nothing about what a viewer already sees.
 */
export function backgroundColorFor(background: BackgroundMode): string | null {
  return background === 'black' ? '#101014' : null
}

/**
 * What the overlay should actually offer to enter, given what the user last
 * chose (`requested`, from the persisted preference or the radio the user is
 * currently pointing at) and whether THIS device reports an `immersive-ar`
 * session at all (`arAvailable`, from `navigator.xr.isSessionSupported`).
 *
 * A stored or mid-selection `'passthrough'` is not trustworthy on its own: it
 * may have been written on a Quest and then the same browser profile opened
 * on a desktop with no AR device, or the radio may render before the
 * `isSessionSupported` probe resolves. Falling back to `'black'` - the one
 * mode every WebXR device in this app's support matrix can enter - keeps the
 * single "VR betreten" button from ever calling `xrStore.enterAR()` on a
 * device that will only reject it.
 */
export function availableBackground(requested: BackgroundMode, arAvailable: boolean): BackgroundMode {
  if (requested === 'passthrough' && !arAvailable) return 'black'
  return requested
}

/** The other choice - what a toggle row switches a given background TO. */
export function otherBackground(current: BackgroundMode): BackgroundMode {
  return current === 'black' ? 'passthrough' : 'black'
}

/**
 * Whether the dock's background row can actually deliver the switch away from
 * `current` on this device - i.e. whether `otherBackground(current)` survives
 * `availableBackground`'s AR-support fallback unchanged. `black` is always
 * reachable, so this is only ever false for a black->passthrough switch on a
 * device with no `immersive-ar` support; reuses `availableBackground` rather
 * than re-deriving the same fallback rule a second time.
 */
export function backgroundToggleAvailable(current: BackgroundMode, arAvailable: boolean): boolean {
  const target = otherBackground(current)
  return availableBackground(target, arAvailable) === target
}

/**
 * What the dock's background row says: the SWITCH TARGET, not the current
 * state - the same "names the state it moves TO" rule the shell's own
 * Curved/Flat row and this app's other toggles (`DockTransport.tsx`'s
 * `LABEL`) already follow, because at 2 m through a lens „what happens if I
 * press this" is the only question a comparison toggle has to answer.
 */
export function backgroundToggleLabel(current: BackgroundMode): string {
  return `Hintergrund: ${otherBackground(current) === 'passthrough' ? 'Durchsichtig' : 'Schwarz'}`
}
