import { useMemo } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { HeadLocked } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { activeCue, seekFeedback } from './subtitleHudState'
import { normalizeCueText } from './transcriptState'

const SUBTITLE_BG = '#0c0c12'
const FEEDBACK_BG = '#14141c'
const SUBTITLE_MAX_WIDTH_PX = 520

/**
 * Player-mode HUD: an open captions readout and non-interactive seek
 * feedback (spec §8), both rendered head-locked via sphere-shell 0.3.0's
 * `<HeadLocked>` (this app's first real consumer of it - see that
 * component's own doc comment for why it lazily chases the viewer's gaze
 * rather than being pinned rigidly, and why it is hit-transparent by
 * construction). Mounted as a SIBLING of `<WindowShell>`, not inside it - a
 * `<HeadLocked>` is not a window (`App.tsx`), per that component's own doc
 * comment ("mount it anywhere alongside `<WindowShell>`").
 *
 * Two independent pieces, either or both visible at once:
 * - **Open captions**: the active cue's text (from `store.cues`, via
 *   `subtitleHudState.ts`'s `activeCue`, built on `transcriptState.ts`'s
 *   `activeCueIndex` - reused, not re-derived), shown while `subtitlesOn` and
 *   the episode actually has cues. Font size 22 - comfortably above the
 *   brief's ">= 20px equivalent" floor - on a dark, near-opaque backdrop
 *   panel for legibility against arbitrary scene content behind it.
 * - **Seek feedback**: while the timeline is being dragged
 *   (`seekPreviewS !== null`), the target `M:SS`/`H:MM:SS` plus - when the
 *   episode has segments - the chapter/segment title there
 *   (`subtitleHudState.ts`'s `seekFeedback`, itself built on
 *   `chaptersState.ts`'s `activeSegmentIndex` - Task 14's chapter-lookup
 *   logic, not duplicated here). Shown regardless of `subtitlesOn`: this is
 *   scrubbing feedback, not a caption.
 *
 * The whole `<HeadLocked>` mounts only when at least one of the two would
 * have something to show (`(subtitlesOn && cues.length > 0) ||
 * seekPreviewS !== null`, per the brief) - not unconditionally with empty
 * children, so there's no lazy-follow group tracking the camera for nothing
 * while the episode has no captions and no drag is in progress.
 *
 * "-" (a plain ASCII hyphen), not "·" (U+00B7): `docs/UIKIT-NOTES.md` entry 3
 * confirms the middle dot is a missing glyph ("tofu box") in this project's
 * installed uikit default font.
 *
 * ## Live finding: text at `<HeadLocked>`'s default offset reads as "italic" on THIS desktop preview camera - not a font or positioning bug
 *
 * First live pixel check of `<HeadLocked>` (this component is its first real
 * consumer): with captions on and no seek in progress, the caption text
 * rendered visibly SLANTED, as if in an italic face. Root-caused live via
 * the console, not guessed:
 * - The SAME `fontSignal.value` object (`===`, not just equal) backs this
 *   Text and an ordinary `Window`'s Text - one confirmed font resource, no
 *   font-family/weight difference.
 * - The Text mesh's own `matrixWorld` local +Z axis is exactly parallel to
 *   the vector toward the camera (`dot` of the two unit vectors = 1.0,
 *   floating-point exact) - the panel is a mathematically perfect billboard,
 *   not mis-oriented.
 * - Forcing `config={{ offsetPitchDeg: 0 }}` (dead-center, overriding
 *   `DEFAULT_HEADLOCKED`'s `-15`) made the SAME text render perfectly
 *   upright. Increasing `distance` instead (to 2.2, same `-15°` offset) did
 *   NOT fix it - confirming the effect tracks the ANGLE off the camera's
 *   forward axis, not the distance.
 *
 * So this is keystone/shear from viewing a close (1.2 m default), flat,
 * camera-facing panel that sits OFF the camera's principal axis (15° below
 * dead-center, by `DEFAULT_HEADLOCKED.offsetPitchDeg`'s own design - "below
 * the primary content, out of the way") through a WIDE single perspective
 * camera (this app's `fov: 70`, see `App.tsx`) - a real property of
 * monoscopic perspective projection on an off-axis rigid quad, not a defect
 * in `<HeadLocked>`'s placement math (verified exact above) or in this
 * component. A real XR headset renders each eye through its own narrower,
 * lens-corrected frustum, so the effect is expected to be far less
 * pronounced or absent there - this project's WebXR verification has no
 * device to confirm that against (see `docs/`'s WebXR verification notes),
 * so it is reported, not silently "fixed" by fighting the desktop camera's
 * approximation (overriding `offsetPitchDeg` to keep this one HUD literally
 * dead-center would defeat the whole point of that default - "below the
 * primary content" - for a camera-specific artifact elsewhere). Flagged for
 * whoever next drives real hardware.
 */
export function SubtitleHud({ store }: { store: PlayerStoreApi }) {
  const cues = useStore(store, (s) => s.cues)
  const subtitlesOn = useStore(store, (s) => s.subtitlesOn)
  const currentTimeS = useStore(store, (s) => s.currentTimeS)
  const seekPreviewS = useStore(store, (s) => s.seekPreviewS)
  const segments = useStore(store, (s) => s.episode?.segments)
  const durationMs = useStore(store, (s) => s.episode?.durationMs ?? 0)

  const cue = useMemo(() => activeCue(cues, currentTimeS * 1000), [cues, currentTimeS])
  const feedback = useMemo(
    () => seekFeedback(segments ?? [], seekPreviewS, durationMs),
    [segments, seekPreviewS, durationMs],
  )

  const showCaption = subtitlesOn && cues.length > 0 && cue != null
  const mounted = (subtitlesOn && cues.length > 0) || seekPreviewS !== null
  if (!mounted) return null

  return (
    <HeadLocked>
      <Container flexDirection="column" alignItems="center" gap={10}>
        {feedback != null && (
          <Container backgroundColor={FEEDBACK_BG} paddingX={16} paddingY={8} borderRadius={8}>
            <Text fontSize={16} color="#ffffff">
              {feedback.chapterTitle != null ? `${feedback.timeLabel} - ${feedback.chapterTitle}` : feedback.timeLabel}
            </Text>
          </Container>
        )}
        {showCaption && cue != null && (
          <Container
            backgroundColor={SUBTITLE_BG}
            paddingX={20}
            paddingY={12}
            borderRadius={10}
            maxWidth={SUBTITLE_MAX_WIDTH_PX}
          >
            {/* Real VTT cues carry their own embedded `\n` - see
                `transcriptState.ts`'s `normalizeCueText` doc comment. */}
            <Text fontSize={22} color="#ffffff" textAlign="center">{normalizeCueText(cue.text)}</Text>
          </Container>
        )}
      </Container>
    </HeadLocked>
  )
}
