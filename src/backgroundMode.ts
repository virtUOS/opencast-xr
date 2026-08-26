/**
 * The player's background choice, before a session starts — "schwarz" or
 * "durchsichtig" — and the one piece of WebXR plumbing that choice implies:
 * which session mode to enter.
 *
 * ## Why this exists at all, and why it is scoped to the start overlay
 *
 * `apps/demo/src/backgroundMode.ts` is the reference for this: same
 * reasoning (background is a session-mode property, not a scene property —
 * see that file's doc comment for the full `environmentBlendMode` story),
 * same two-value type, same idea that a set scene background paints over the
 * passthrough camera feed.
 *
 * What did NOT come along is the demo's in-session restart machinery
 * (`planBackgroundSwitch`, `effectiveBackground`, `otherBackground`,
 * `SessionModeBridge`): those exist to support a dock-mounted toggle that can
 * flip the background WHILE a session is running. The player has no such
 * control yet — sphere-shell 0.3.0's dock „..." menu is a closed set
 * (`DockMenuItemId = 'arrange' | 'recenter' | 'curved'`, and `dockMenuItems`
 * takes no app-supplied rows; `DockProps` only exposes the app slot in the
 * control strip, which the shell renders OUTSIDE the three-dot menu). So for
 * now the only place this choice is ever made is the start overlay, before
 * `XR.requestSession` — which is exactly the one case where no restart logic
 * is needed at all: entering fresh into the wanted mode via
 * `xrStore.enterAR()`/`enterVR()` reaches it directly, in one step. See
 * `App.tsx`'s `enterWithBackground` and the NEEDS_LIBRARY_API note this task
 * left about the menu.
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
