import type { AngularSize, SphericalPosition } from 'sphere-shell'
import type { Episode } from '../opencast/types'
import type { BrowseTarget } from '../player/store'

/**
 * Everything about a video window that is decidable WITHOUT React, uikit or a
 * shell store: the window id, its start placement, and the one-step
 * reconciliation between the shell's own window state and the player store's
 * stream state. `VideoWindows.tsx` is deliberately thin glue over this file,
 * for the same reason `libraryState.ts` exists next to `LibraryWindow.tsx` -
 * uikit components can't render meaningfully in jsdom, so the logic worth
 * testing has to live outside them.
 */

/** The shell window id for one flavor's video window. The mapping is fixed (plan, Task 12). */
export function videoWindowId(flavorType: string): string {
  return `video-${flavorType}`
}

/** All video windows are 16:9 frames; the video inside letterboxes itself (see VideoSurface). */
export const VIDEO_ASPECT = 16 / 9

/**
 * ## „Am Start nur die Videofenster einblenden und das moeglichst gross"
 *
 * The second round of Quest feedback, and it is two changes that only make
 * sense together: the panel windows (Kapitel, Transkript, Reihe, Info) now
 * start CLOSED - present as dock tiles, one click away - and the space they
 * were occupying goes to the video.
 *
 * The angular budget those numbers come from:
 *
 * - **Usable azimuth is about +-55 degrees.** A Quest 3's horizontal field of
 *   view is roughly 110 degrees, so a window that stays inside +-55 can be read
 *   without turning the head. The shell's own bounds are far wider (+-110), so
 *   they are not the constraint here - comfort is.
 * - **The dock is at -30 degrees elevation** and about 7 degrees tall, so
 *   anything below about -26 collides with it. A 16:9 window centred at
 *   elevation 0 reaches half its height down, which is what caps the widths
 *   below.
 *
 * With ONE stream (the overwhelmingly common case in a real Opencast corpus -
 * every recording on develop.opencast.org has a single video flavor) there is
 * no second window to leave room for, so it gets 64 degrees: half-width 32,
 * comfortably inside the budget, and half-height 18, clear of the dock.
 *
 * With TWO it is 52 degrees each at +-27, i.e. the pair spans -53..53 with a
 * 2-degree gap between them - as wide as two streams can be while both stay
 * inside the comfortable arc. That is a 30 % linear (69 % area) increase on the
 * 40 degrees they had before.
 *
 * THREE or more keeps the previous layout unchanged (40-degree mains, 24-degree
 * flanks): with a flank pair already out at +-55 there is no width left to give
 * away, and no real recording gets there anyway - only this app's dev-only
 * „Zweiter Stream (Test)" toggle produces even a second stream.
 */
export const SOLO_WIDTH_DEG = 64
/** Angular width of each of the two main windows when the recording has exactly two streams. */
export const PAIR_WIDTH_DEG = 52
/** ...placed symmetrically about straight-ahead at this azimuth (half-width plus half the gap). */
export const PAIR_AZIMUTH_DEG = 27
/** Angular width of the first two streams' windows once a THIRD stream exists. */
export const MAIN_WIDTH_DEG = 40
/** ...placed symmetrically about straight-ahead at this azimuth. */
export const MAIN_AZIMUTH_DEG = 24
/** Angular width of the third and further streams' windows. */
export const SIDE_WIDTH_DEG = 24
/** ...placed out on the flanks at this azimuth. */
export const SIDE_AZIMUTH_DEG = 55
/** Vertical gap between two stacked flank windows. */
export const SIDE_ROW_GAP_DEG = 2

export interface VideoWindowPlacement {
  size: AngularSize
  position: SphericalPosition
}

/**
 * Start layout for the video window of the stream at `index` in
 * `PlayerStore.streams` (which is `selectStreams`' order: presenter,
 * presentation, then alphabetical), for a recording with `streamCount` streams
 * in total.
 *
 * The count is a parameter and not an ambient constant because the SIZE depends
 * on it - see the sizing constants above for the angular budget. `index` alone
 * cannot answer "how wide should the first window be", which is exactly the bug
 * the previous signature had: a lone stream got the same 40 degrees as one of a
 * pair, and the other 25 degrees of comfortable arc went unused.
 *
 * Even indices go left, odd indices right, so a pair sits symmetrically and the
 * flanks pair up the same way. A fifth stream and beyond stacks DOWNWARD on the
 * flanks (one row per pair) rather than widening the arc: the shell's default
 * bounds stop at +-110 deg azimuth and -40 deg elevation, so rows past the third
 * would be clamped by the shell - acceptable, since no real Opencast recording
 * has eight video flavors, and a clamped-but-visible window beats an off-shell
 * one.
 */
export function videoWindowPlacement(index: number, streamCount: number): VideoWindowPlacement {
  const side = index % 2 === 0 ? -1 : 1
  // A count that does not contain `index` (a caller mid-swap, a defensive 0)
  // must not produce a smaller window than the index itself implies.
  const count = Math.max(streamCount, index + 1)

  if (count === 1) {
    return {
      size: { width: SOLO_WIDTH_DEG, height: SOLO_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: 0, elevation: 0 },
    }
  }
  if (index < 2) {
    const width = count === 2 ? PAIR_WIDTH_DEG : MAIN_WIDTH_DEG
    const azimuth = count === 2 ? PAIR_AZIMUTH_DEG : MAIN_AZIMUTH_DEG
    return {
      size: { width, height: width / VIDEO_ASPECT },
      position: { azimuth: side * azimuth, elevation: 0 },
    }
  }
  const height = SIDE_WIDTH_DEG / VIDEO_ASPECT
  const row = Math.floor((index - 2) / 2)
  return {
    size: { width: SIDE_WIDTH_DEG, height },
    position: {
      azimuth: side * SIDE_AZIMUTH_DEG,
      // Spelled out rather than `-row * step` so row 0 is +0 and not -0: the
      // shell serializes positions into layouts that get compared by value.
      elevation: row === 0 ? 0 : -(row * (height + SIDE_ROW_GAP_DEG)),
    },
  }
}

/**
 * Where browse mode should land after closing the LAST open video window -
 * the user's own directive: „Wenn beim letzten Video das x zum fenster
 * schließen gedrückt wird, sollte man in die vorherige Auswahl zurück
 * kommen." The "previous selection" is the scope the episode was FOUND in:
 * the series' own episode list for an episode that has one (mirroring the
 * dock breadcrumb's „Reihe" crumb - `DockTransport.tsx`'s `onCrumb`), or the
 * „Einzelaufzeichnungen" singles group for one that does not, since a
 * series-less recording was never listed at level 1 directly.
 *
 * Falls back to the series id when `seriesTitle` is missing - same reasoning
 * as `breadcrumbTrail`'s series crumb: a raw id is ugly but navigable and
 * honest, and dropping the target for a missing title would be worse than
 * showing it.
 */
export function libraryReturnTarget(episode: Pick<Episode, 'seriesId' | 'seriesTitle'>): BrowseTarget {
  if (episode.seriesId != null) {
    return { kind: 'series', sid: episode.seriesId, title: episode.seriesTitle ?? episode.seriesId }
  }
  return { kind: 'singles' }
}

/**
 * The second line of the stream-error tile: what the user can do if „Neu laden"
 * does not help, or `null` when the tile does not need to say.
 *
 * Only the LAST open stream gets one, and it exists because that case used to
 * have no obvious way out: `canClose` refused to unload the last stream, so
 * the window's own X was vetoed (closed and immediately restored). Since the
 * last-open-window close now NAVIGATES back to the library instead of being
 * vetoed (`streamWindowAction`'s `'exit-to-library'` - see its own doc
 * comment), the X itself is that way out, and this hint says so directly
 * rather than pointing at a separate control. The reload button still covers
 * a transient failure; this line covers a permanent one. With another stream
 * still up there is nothing to explain - the X works exactly as it always
 * has, and the rest of the wall keeps playing.
 *
 * NAMES THE MECHANISM, NOT A SPECIFIC CONTROL LABEL. The previous wording
 * named the dock's „Home" crumb (itself a fix for an earlier drift, when it
 * had named a since-removed „Bibliothek" button) - two driftable strings in a
 * row is a pattern, and "close this window" cannot go stale the way a control
 * NAME can, because it is this exact tile's own window being described.
 *
 * @param canClose `PlayerStore.canClose(flavorType)` for this window's stream.
 */
export function streamErrorEscapeHint(canClose: boolean): string | null {
  if (canClose) return null
  return 'Einziger Stream dieser Aufzeichnung - hilft Neu laden nicht, das X am Fenster bringt jetzt zurück zur Bibliothek.'
}

export type StreamWindowAction =
  | 'none'
  | 'close-stream'
  | 'reopen-stream'
  | 'exit-to-library'
  | 'reset-window'

export interface StreamWindowSyncInput {
  /**
   * The shell's entry for this window, or `undefined` while `<Window>` hasn't
   * registered yet (first render) or has already unregistered (unmount).
   *
   * `minimized` is part of this input even though no rule below reads it. That
   * is the point: minimizing must NEVER unload a stream (spec §7 unloads on
   * CLOSE only), so the distinction is stated - and tested - here rather than
   * left to be re-derived from the fact that the code happens to look at
   * `closed` alone.
   */
  shell: { closed: boolean; minimized: boolean } | undefined
  /** `PlayerStore.streams`' `open` flag for this flavor; `undefined` = no such stream. */
  streamOpen: boolean | undefined
  /** `PlayerStore.canClose(flavorType)` - false exactly when this is the last open stream. */
  canClose: boolean
  /**
   * True on the first evaluation after the open episode changed - i.e. this
   * window is now showing a DIFFERENT recording's stream than the state it is
   * being compared against was produced for.
   *
   * This exists to disarm a trap: `openEpisode` rebuilds `streams` with every
   * flavor `open: true`, but it cannot touch the shell, so a flavor the user
   * had CLOSED in the previous episode still carries `closed: true` in the
   * shell's window entry. Without this flag the very first comparison after the
   * swap reads "shell closed, stream open" and unloads the new recording's
   * stream on arrival - silently, and (with two or more streams, where
   * `canClose` permits it) permanently. The stale flag has to be cleared
   * BEFORE the normal rules are allowed to fire, which is what 'reset-window'
   * does.
   */
  episodeChanged: boolean
}

/**
 * Reconciles the shell's window state with the player store's stream state for
 * ONE flavor, and says what to do about a disagreement.
 *
 * This exists because sphere-shell has no `onRestore` callback: a dock-tile
 * click just clears the window's `closed` flag in the shell store, so the only
 * way to notice a restore is to watch that flag. Watching it also covers a
 * close initiated anywhere other than our own `onClose` (the shell's own
 * `close()` API, a future keyboard shortcut), which is why this is the primary
 * mechanism and `onClose` is only a same-frame shortcut on top of it.
 *
 * LEVEL-triggered, not edge-triggered: it compares the two current states
 * rather than remembering the previous one. Both are equivalent here (every
 * action below makes the two states agree, so the very next evaluation returns
 * 'none'), and re-deriving from current state cannot get stuck holding a stale
 * "previous" value - the same reasoning as SyncEngine's `reconcileStall`.
 *
 * 'reset-window' is the one step that writes to the SHELL rather than the store:
 * it clears a `closed`/`minimized` flag left over from the previous episode, and
 * it takes precedence over every other rule (see `episodeChanged`).
 *
 * 'exit-to-library' is the one asymmetry: sphere-shell's `<Window>` has no
 * `closable` prop, so the last open stream's window cannot suppress its own X
 * button. The shell closes it, the store refuses to unload the stream
 * (`canClose` false - without a stream there is no player) - and rather than
 * undoing the shell's close (the OLD "veto", which used to restore the window
 * right back open), the caller now ACCEPTS the close as the trigger to leave
 * player mode entirely: „Wenn beim letzten Video das x zum fenster schließen
 * gedrückt wird, sollte man in die vorherige Auswahl zurück kommen." See
 * `VideoWindows.tsx`'s `useStreamWindowSync` and `libraryReturnTarget` above
 * for where that lands.
 */
export function streamWindowAction(input: StreamWindowSyncInput): StreamWindowAction {
  const { shell, streamOpen, canClose, episodeChanged } = input
  // Not registered (or already gone), or no such stream: nothing is being
  // disagreed about yet. Notably this is the first-render state, where acting
  // on a missing entry would look exactly like "the shell closed it".
  if (shell === undefined || streamOpen === undefined) return 'none'

  // A fresh recording's stream is never something to close or reopen: the
  // shell's flags describe the PREVIOUS episode's window, so they are cleared
  // (once) and the normal rules take over from the next evaluation. See
  // `episodeChanged`. Minimized is cleared along with closed - a new recording
  // starts with its windows up.
  if (episodeChanged) return shell.closed || shell.minimized ? 'reset-window' : 'none'

  if (shell.closed && streamOpen) return canClose ? 'close-stream' : 'exit-to-library'
  if (!shell.closed && !streamOpen) return 'reopen-stream'
  return 'none'
}
