import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { PANEL_WINDOW_IDS } from './panelWindows'
import { useStartClosed } from './useStartClosed'

// Umlauts are fine here - Task 11's live verification against the real
// server confirmed uikit's default font renders accented Latin letters
// (LibraryWindow.tsx's own "Zurück" label ships with one); the tofu-glyph
// defect documented in docs/UIKIT-NOTES.md entry 3 was specifically about
// typographic PUNCTUATION ("‹", "·", "…"), not diacritics.
const NO_CAPTIONS_HINT = 'Keine Untertitel für diese Aufzeichnung verfügbar.'
const LABEL_COLOR = '#9a9aa5'

/**
 * Player-mode metadata panel: what you are watching (title, creators, series,
 * duration-independent facts) and nothing you can operate.
 *
 * ## Why it has no controls any more (user-feedback round)
 *
 * It used to be „Steuerung" and carried the volume stepper and the subtitle
 * toggle alongside the metadata. Both moved to the DOCK, on the user's
 * instruction, and the reasoning generalises: a control you reach for WHILE
 * watching should be in the one panel that is always in the same place and
 * always aimable, not in a window that competes for gaze with the video and
 * can be minimized, moved or closed. The dock is also where the transport
 * already was, so mute/volume/captions now sit next to play/pause instead of
 * a head-turn away from it.
 *
 * Metadata is the opposite kind of content - you read it once, deliberately -
 * so it stays in a window, and this window is now just that. Retitled „Info"
 * to say so. Dropping it entirely was considered and rejected: creators and
 * the series name are not shown anywhere else in player mode (the dock's
 * breadcrumb shows a TRUNCATED title and the series name, nothing else), and
 * they are exactly what someone checks when they are unsure which recording
 * they opened.
 *
 * The caption hint stays here rather than moving with the toggle: the dock's
 * captions button greys out when a recording has no cues, which says „not
 * available" but not WHY, and there is no room in a dock row for a sentence.
 */
export function ControlsWindow({ store }: { store: PlayerStoreApi }) {
  const episode = useStore(store, (s) => s.episode)
  const cuesCount = useStore(store, (s) => s.cues.length)
  // Starts as a dock tile rather than on the shell - see `panelWindows.ts`. The
  // dock's „i" button is the other way back to it.
  useStartClosed(PANEL_WINDOW_IDS.info)

  // Defensive only: App.tsx mounts this exclusively in player mode, which
  // always has an episode by the time `mode` flips (store.ts's `openEpisode`
  // sets both in the same `set()` call).
  if (!episode) return null

  return (
    <Window
      id="controls"
      title="Info"
      // Shorter than the 26x22 it needed with the volume row and the toggle in
      // it - this is text only now.
      size={{ width: 26, height: 14 }}
      position={{ azimuth: 0, elevation: 22 }}
      // No dock tile: the dock's own „i" button opens and closes this window,
      // so a tile would be a second control for the same job - „Fuer Fenster
      // die einen Button im Dock haben keine Platzhalter der Fenster im Dock
      // anzeigen". That button honours `dockTile`'s contract (see the prop's doc
      // comment): it restores from CLOSED as well as from minimized, because it
      // goes through the shell's `restore`, which clears both flags.
      dockTile={false}
    >
      <Container flexDirection="column" gap={6} padding={12} flexGrow={1}>
        <Text fontSize={14} color="#ffffff">{episode.title}</Text>
        {episode.creators.length > 0 && (
          <Text fontSize={12} color={LABEL_COLOR}>{episode.creators.join(', ')}</Text>
        )}
        {episode.seriesTitle != null && <Text fontSize={12} color={LABEL_COLOR}>{episode.seriesTitle}</Text>}
        {cuesCount === 0 && <Text fontSize={11} color="#8a8a95">{NO_CAPTIONS_HINT}</Text>}
      </Container>
    </Window>
  )
}
