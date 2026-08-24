import { useEffect, useRef } from 'react'
import { useShellStore, useWindowState } from 'sphere-shell'

/**
 * Closes a panel window ONCE, the first time it registers with the shell, so
 * player mode opens showing the video and nothing else („Am Start nur die
 * Videofenster einblenden" - see `panelWindows.ts` for the whole rationale,
 * including why closed-with-a-dock-tile rather than not-mounted).
 *
 * ## Why it watches the entry instead of just firing on mount
 *
 * Two of the four panels (Kapitel, Reihe) return `null` - and therefore
 * register no window at all - until the open recording has the data they show.
 * A plain mount effect would fire while there was nothing to close, mark itself
 * done, and let the window appear open the moment the data arrived. Watching
 * `useWindowState(id)` instead means "close it when it exists", which is the
 * actual requirement, and it costs one already-subscribed selector.
 *
 * ## Why it is once per MOUNT, and not once per episode
 *
 * `<App>` swaps the whole player tree on `mode`, so a mount here is exactly
 * "the user just opened a recording from the library" - which is the moment the
 * user described. An episode change WITHIN player mode (the dock's prev/next,
 * a click in the Reihe window) leaves this component mounted and therefore
 * leaves the panels exactly as the user arranged them, which is the friendlier
 * behaviour: someone who opened the transcript and stepped to the next lecture
 * of the same series meant to keep reading it.
 *
 * The `applied` ref is what makes it once rather than a loop: closing the
 * window changes the entry, which re-runs this effect, and without the guard
 * the user's own restore (from the dock tile) would be undone on the very next
 * commit.
 *
 * ## ...and why the guard resets when the window UNREGISTERS
 *
 * Once-ever was wrong, on a path the dock's own previous/next buttons walk
 * (code review, I3). Two of the four panels unregister when the open recording
 * has nothing for them: step from a recording WITH chapters (Kapitel
 * registered, then closed by this hook) to a sibling WITHOUT (Kapitel returns
 * `null`, so `<Window>` unregisters and the entry is gone), then back to one
 * with - and Kapitel registers afresh, open, popping onto the shell in the
 * middle of a lecture the user never asked it for.
 *
 * A window that has left the shell's registry is a NEW window when it comes
 * back: it has no `closed` flag, no dock tile and no position of its own any
 * more. So the ref follows the registration rather than the component - cleared
 * the moment the entry goes away, re-applied when a fresh one appears. The
 * user's own restore is still safe, because a restore does not unregister
 * anything; only the data gate flipping (or player mode unmounting) does.
 *
 * Writes through the SHELL store, never through a player-store flag - the shell
 * owns open/closed; see `panelWindows.ts`.
 */
export function useStartClosed(id: string): void {
  const shellStore = useShellStore()
  const entry = useWindowState(id)
  const applied = useRef(false)

  useEffect(() => {
    // Not registered (first render, or gated off by the window's own data).
    // Arm for the NEXT registration - see the doc comment: a window that left
    // the registry comes back as a new one.
    if (!entry) {
      applied.current = false
      return
    }
    if (applied.current) return
    applied.current = true
    shellStore.getState().close(id)
  }, [entry, id, shellStore])
}
