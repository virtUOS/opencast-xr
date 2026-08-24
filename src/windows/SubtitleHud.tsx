import { useMemo, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { HeadLocked } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { activeCue, seekFeedback } from './subtitleHudState'
import { normalizeCueText } from './transcriptState'

const HUD_BG = '#000000'
/**
 * How dark the caption backdrop is - the user's „nur leicht abgedunkelt, aber
 * nicht schwarz". The panel used to be a near-opaque near-black slab, which
 * legibility-wise was safe and in practice punched a black hole through the
 * middle of whatever was being watched. 0.4 was picked by eye against a bright
 * video frame: enough to keep white text readable over near-white content,
 * light enough that the picture stays visible through it.
 */
const HUD_BG_OPACITY = 0.4
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
 *   brief's ">= 20px equivalent" floor - over a lightly darkening translucent
 *   backdrop (`HudPanel`, `HUD_BG_OPACITY`) that keeps white text readable
 *   without blacking out the picture behind it.
 *
 * Its world size is user-adjustable from the dock (`subtitleScale` on the
 * store, `<group scale>` here) - see `subtitleHudState.ts`'s
 * `SUBTITLE_SCALE_STEPS`.
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
/**
 * A HUD panel whose BACKDROP is translucent while its content stays fully
 * opaque.
 *
 * The obvious spelling - `opacity` on the panel `Container` itself - does not
 * work for this: `opacity` is one of `@pmndrs/uikit` 1.0.74's INHERITED
 * properties (`dist/properties/inheritance.js` lists it), so it dims the
 * caption text along with the panel behind it and the result is grey text on a
 * grey wash instead of white text on a light darkening. (There is no
 * `backgroundOpacity` prop in this version either - grep of the installed
 * package finds that name only as a local in the panel material's generated
 * shader, never in `properties/schema.d.ts`. `opacity` IS the background
 * opacity, for a Container.)
 *
 * So the backdrop is its own absolutely-positioned child, stretched to the
 * padded box, carrying the `opacity` alone - a sibling of the content rather
 * than its ancestor, which puts it outside the inheritance chain by
 * construction rather than by an override that a later edit could undo.
 * `pointerEvents="none"` on it is belt-and-braces: `<HeadLocked>`'s own root
 * already makes the whole HUD hit-transparent.
 */
function HudPanel({
  paddingX,
  paddingY,
  borderRadius,
  maxWidth,
  children,
}: {
  paddingX: number
  paddingY: number
  borderRadius: number
  maxWidth?: number
  children: ReactNode
}) {
  return (
    <Container paddingX={paddingX} paddingY={paddingY} maxWidth={maxWidth} alignItems="center">
      <Container
        positionType="absolute"
        positionLeft={0}
        positionRight={0}
        positionTop={0}
        positionBottom={0}
        backgroundColor={HUD_BG}
        opacity={HUD_BG_OPACITY}
        borderRadius={borderRadius}
        pointerEvents="none"
      />
      {children}
    </Container>
  )
}

export function SubtitleHud({ store }: { store: PlayerStoreApi }) {
  const cues = useStore(store, (s) => s.cues)
  const subtitlesOn = useStore(store, (s) => s.subtitlesOn)
  const currentTimeS = useStore(store, (s) => s.currentTimeS)
  const seekPreviewS = useStore(store, (s) => s.seekPreviewS)
  const segments = useStore(store, (s) => s.episode?.segments)
  const durationMs = useStore(store, (s) => s.episode?.durationMs ?? 0)
  const subtitleScale = useStore(store, (s) => s.subtitleScale)

  const cue = useMemo(() => activeCue(cues, currentTimeS * 1000), [cues, currentTimeS])
  const feedback = useMemo(
    () => seekFeedback(segments ?? [], seekPreviewS, durationMs),
    [segments, seekPreviewS, durationMs],
  )

  const showCaption = subtitlesOn && cues.length > 0 && cue != null
  const mounted = (subtitlesOn && cues.length > 0) || seekPreviewS !== null
  if (!mounted) return null

  return (
    // The documented way to resize a head-locked container: sphere-shell's
    // README ("Rescaling", under HeadLocked HUD containers) says positioning is
    // correct under an arbitrary parent transform, so a `<group scale>` around
    // it is supported - and it is the RIGHT mechanism for text specifically,
    // because uikit draws glyphs from an SDF atlas and so a uniform transform
    // scale stays crisp, whereas driving `fontSize` would re-wrap the caption
    // and leave padding/corner radius at a pixel size that no longer matches.
    // See `SUBTITLE_SCALE_STEPS` in subtitleHudState.ts for why the factors are
    // all well below 1.
    <group scale={subtitleScale}>
      <HeadLocked>
        <Container flexDirection="column" alignItems="center" gap={10}>
          {feedback != null && (
            <HudPanel paddingX={16} paddingY={8} borderRadius={8}>
              <Text fontSize={16} color="#ffffff">
                {feedback.chapterTitle != null ? `${feedback.timeLabel} - ${feedback.chapterTitle}` : feedback.timeLabel}
              </Text>
            </HudPanel>
          )}
          {showCaption && cue != null && (
            <HudPanel paddingX={20} paddingY={12} borderRadius={10} maxWidth={SUBTITLE_MAX_WIDTH_PX}>
              {/* Real VTT cues carry their own embedded `\n` - see
                  `transcriptState.ts`'s `normalizeCueText` doc comment. */}
              <Text fontSize={22} color="#ffffff" textAlign="center">{normalizeCueText(cue.text)}</Text>
            </HudPanel>
          )}
        </Container>
      </HeadLocked>
    </group>
  )
}
