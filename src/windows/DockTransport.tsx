import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { ThreeEvent } from '@react-three/fiber'
import { Container, Text, type VanillaContainer } from '@react-three/uikit'
import {
  ALargeSmall,
  Captions,
  CaptionsOff,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  House,
  Info,
  List,
  LoaderCircle,
  Minus,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from '@react-three/uikit-lucide'
import { useShellStore, useWindowState } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import type { SeriesStateApi } from './seriesState'
import { PANEL_WINDOW_IDS, panelToggleAction, type PanelWindowId } from './panelWindows'
import {
  derivePlaybackVisualState,
  fractionToSeconds,
  secondsToFraction,
  stepVolume,
  transportTimeParts,
  volumeToPercent,
} from './transportState'
import {
  MAX_CAPTION_OFFSET_DEG,
  MAX_CAPTION_SCALE,
  MIN_CAPTION_OFFSET_DEG,
  MIN_CAPTION_SCALE,
  captionScaleLabel,
  stepCaptionOffset,
  stepCaptionScale,
} from '../captionScale'
import {
  adjacentEpisodes,
  breadcrumbTrail,
  needsMoreEpisodes,
  playableEpisodes,
  type Crumb,
} from './breadcrumbState'
import {
  type DragEffect,
  type DragState,
  initialDragState,
  rayToTrackFraction,
  reduceDrag,
} from './timelineDrag'

const BUTTON_ICON_PX = 15
const SMALL_ICON_PX = 13
const TRACK_HEIGHT_PX = 6
/**
 * Least width the timeline is ever laid out at. It normally takes whatever row
 * 1 has left over (`flexGrow`), which is "the whole width of the dock" minus
 * the two time readouts - see this file's doc comment. The floor only matters
 * for a degenerate row (a recording whose breadcrumb is unusually short), where
 * without it the track could collapse to a few pixels and become unaimable.
 */
const TRACK_MIN_WIDTH_PX = 180
const ROW_HEIGHT_PX = 30
/** The second row is text-and-small-buttons only, so it needs less height than row 1's timeline. */
const CRUMB_ROW_HEIGHT_PX = 24
const ROW_GAP_PX = 6
/**
 * The Play/Pause button spans BOTH rows, at the user's request („Nur der
 * Play/Pause Button sollte beide Zeilen ueberspannen") - so it is exactly as
 * tall as the two rows plus the gap between them, and square.
 */
const PLAY_BUTTON_PX = ROW_HEIGHT_PX + ROW_GAP_PX + CRUMB_ROW_HEIGHT_PX
/** Fixed width for each time readout, so the timeline's own width does not twitch as the digits change. */
const TIME_LABEL_WIDTH_PX = 46

const BUTTON_BG = '#2c2c3a'
const BUTTON_BG_HOVER = '#3a3a4a'
const ACTIVE_BG = '#2f4f6f'
const ACTIVE_BG_HOVER = '#3f6f9f'
const DISABLED_COLOR = '#5a5a65'
const CRUMB_COLOR = '#cfd8ff'
const CRUMB_CURRENT_COLOR = '#9a9aa5'

/**
 * A square icon button in the dock's own idiom. Exists because this component
 * now renders eight of them and the disabled variant has a real trap in it:
 * `hover` must stay a plain object on every render, never
 * `disabled ? undefined : {...}` - that exact conditional crashes the scene a
 * few hundred ms later, inside r3f's reconciler, during an unrelated tree
 * replacement. Reproduced and bisected in this app; see `docs/UIKIT-NOTES.md`
 * entry 1 and `ControlsWindow.tsx`'s history. Encoding "no hover" as a hover
 * colour equal to the resting colour is the fix, and having it in one helper
 * is how it stays applied.
 */
function IconButton({
  size = ROW_HEIGHT_PX,
  background = BUTTON_BG,
  hoverBackground = BUTTON_BG_HOVER,
  disabled = false,
  onPress,
  children,
}: {
  size?: number
  background?: string
  hoverBackground?: string
  disabled?: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Container
      width={size}
      height={size}
      alignItems="center"
      justifyContent="center"
      backgroundColor={background}
      borderRadius={6}
      hover={{ backgroundColor: disabled ? background : hoverBackground }}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled) return
        onPress()
      }}
    >
      {children}
    </Container>
  )
}

/**
 * The dock's player-mode transport: one big Play/Pause button spanning two
 * rows, and beside it
 *
 * - **row 1** - nothing but the timeline, flanked by the position and duration
 *   readouts;
 * - **row 2** - everything else: the `Home > Reihe > aktuelle Aufzeichnung`
 *   breadcrumb, previous/next episode, the captions controls (on/off, and -
 *   only while captions are ON - size and vertical position), mute and volume,
 *   and the „i" button for the Info window.
 *
 * That shape is the user's, after wearing the headset („Die Zeitleiste sollte
 * ueber die gesamte Breite des Docks gehen. Andere Buttons sind wie die
 * Breadcrumbs unter der Zeitleiste. Nur der Play/Pause Button sollte beide
 * Zeilen ueberspannen"), and it is a good one for a controller ray: the two
 * controls used most are also the two largest and the two easiest to hit
 * without aiming precisely - a 60 px square and a track as wide as the dock.
 *
 * ## How the timeline gets „die gesamte Breite" without a magic number
 *
 * No fixed width anywhere. The column of two rows sizes itself to its WIDEST
 * child, which is always row 2 (a breadcrumb plus a dozen buttons); row 1
 * stretches to that width because a flex column's default `alignItems` is
 * `stretch`; and the track alone carries `flexGrow={1}`, so it absorbs
 * everything row 1 does not spend on the two fixed-width time readouts.
 *
 * The alternative - a constant `SLOT_WIDTH_PX` - was rejected: row 2's real
 * width depends on the breadcrumb's truncated labels, whether the recording has
 * a series at all, and whether captions are on, so any constant is either too
 * small (row 2 overflows the strip, since uikit's flex children do not shrink
 * by default) or too large (a dock with dead space in it). Sizing to content in
 * one axis and growing into it in the other is exactly what flexbox is for, and
 * it re-solves itself when the caption buttons appear or disappear.
 *
 * ## Two rows inside a one-row dock
 *
 * `Dock.tsx`'s strip is a `flexDirection="row"` uikit Container with
 * `alignItems="center"` and no fixed height, and the app's slot is one child of
 * that row. So a slot child that is itself a `flexDirection="column"` simply
 * becomes a taller row item and the dock grows to fit it - no sphere-shell
 * change needed, and the shell's own controls stay vertically centred beside
 * it. Verified live (screenshot + measured dock height) rather than assumed.
 *
 * The shell's own three-dot menu and red exit X are NOT in row 2, even though
 * the user's sketch put them there: they belong to sphere-shell, which renders
 * them outside the app's slot (and must, since an app cannot know whether a
 * session is running). They sit centred beside the two rows instead, which is
 * the same visual band and the closest an app-side layout can get without the
 * library rendering app content.
 *
 * ## Opening a window from the dock
 *
 * Two controls here open a WINDOW rather than change playback: the
 * current-recording crumb (the Reihe window - the user asked for it, with an
 * icon to say the crumb is now live) and the „i" button (the Info window). Both
 * go through the SHELL store's `restore`/`close`, never through a player-store
 * flag - the shell owns open/closed (see `panelWindows.ts`), and those windows
 * now START closed, so this is the way back to them alongside their dock tiles.
 *
 * ## What moved here, and what left
 *
 * This is the user-feedback round. The volume control and the subtitle toggle
 * came out of `ControlsWindow` (a control you use while watching should not
 * live in a window you have to look away at), and the old „Bibliothek" button
 * is GONE - replaced by the breadcrumb's `Home` crumb, which does the same
 * thing (`toBrowse()`) while also saying where you are. The series crumb goes
 * one better than the old button could: it opens browse mode already scoped to
 * that series' episode list, via the store's one-shot `browseTarget` (see
 * `BrowseTarget` in `player/store.ts`). The current-recording crumb is
 * deliberately inert - it is where you already are.
 *
 * Previous/next step through the series' own episode list in its own order,
 * skipping recordings with nothing to play (`breadcrumbState.ts`'s
 * `playableEpisodes`/`adjacentEpisodes`), disabled at either end, and absent
 * entirely for a series-less recording. They call `store.openEpisode`, which
 * per spec never autoplays: the next lecture lands paused at 0.
 *
 * The series episode list is NOT fetched here - it is the one
 * `createSeriesState` instance `App.tsx` owns and also hands to
 * `SeriesWindow`, so the breadcrumb's neighbours and that window's list are
 * the same fetch and can never disagree.
 *
 * Rendered in `<WindowShell dockControls>` (see `App.tsx`) - App.tsx only
 * mounts this while `mode === 'player'`, which is what makes "Browse mode
 * shows no transport" (the brief's requirement) true; this component does
 * not re-check `mode` itself. Follows the demo's `PlaybackControls`/
 * `BackgroundControl` idiom (`apps/demo/src/App.tsx`): plain uikit
 * `Container`s with `onClick`+`stopPropagation`, sized to the dock's own
 * 30px-tall row.
 *
 * All the fraction<->time math, the time label's shape, the play/pause
 * button's visible state, the ray->fraction plane math, and the drag
 * gesture's own state machine live in the pure, unit-tested
 * `transportState.ts`/`timelineDrag.ts` - this component is deliberately
 * thin glue over them (same split as `libraryState.ts`/`LibraryWindow.tsx`
 * and `videoWindowState.ts`/`VideoWindows.tsx`).
 *
 * ## The timeline's drag math - see `timelineDrag.ts` for the fix history
 *
 * uikit 1.0.74 has no Slider primitive (per the brief), so the track is a
 * plain `Container` and dragging is hand-rolled. Every pointer event is
 * turned into a `fraction: number | null` via `rayToTrackFraction` (reading
 * `e.ray`, NOT `e.point` - see that function's doc comment for exactly why
 * `e.point` silently breaks under pointer capture), then fed into
 * `reduceDrag`'s pure state machine, whose `effects` this component just
 * executes: `capture`/`release` call `setPointerCapture`/
 * `releasePointerCapture` on `e.target`, `preview`/`commit` write to the
 * store (`setSeekPreview` / `engine.seek`), `clearPreview` resets it.
 *
 * `stopPropagation` is called eagerly on `pointerdown` (any press on the
 * track area should suppress e.g. a background look-drag starting, even if
 * `reduceDrag` ends up doing nothing with it - a ray-miss `pointerdown`),
 * but only conditionally on `pointermove`/`pointerup` - exactly when
 * `reduceDrag` actually produced effects for THIS pointer - so an unrelated
 * pointer's move/up over the track (rejected by the reducer's own
 * foreign-pointer gating) is left free to propagate normally.
 *
 * The fill bar is given `pointerEvents="none"` so a raycast that lands on
 * the (frontmost) fill overlay - clicking into the already-played portion
 * of the track - still resolves against the same `track` ref rather than a
 * different mesh with its own local frame.
 *
 * ## Nesting depth: NOT the real issue (code review I2 - re-tested)
 *
 * An earlier draft of this component wrapped `[time-text, track, time-text]`
 * in their own row `Container`, with the pointer handlers on the *nested*
 * track. Live testing at the time seemed to show that Container silently
 * never received a hit at all, while sibling buttons one nesting level
 * shallower kept working - so a prior revision "fixed" it by flattening the
 * pointer-handler Container into a direct child of this component's own
 * fragment, with a (then-plausible) theory about hit-order/
 * `pointerEventsOrder` inheritance through an extra layer inside the dock's
 * injected slot.
 *
 * Re-tested after the `e.ray` fix above (code review I2): with the SAME
 * nested-row structure restored and only the ray-based fraction math in
 * place, both a plain click AND a drag - including one continuing well past
 * the track's own edge - registered correctly and landed exactly where
 * expected (verified live: a right-edge-overshooting drag seeked to the
 * full episode duration; a left-edge-overshooting one seeked to 0). So the
 * nesting depth was never the real mechanism - the original "clicks
 * silently stop registering" observation was almost certainly this same
 * `e.point`-freezes-under-capture bug (see `timelineDrag.ts`), which can
 * make a genuinely-received event resolve to a wildly wrong (or, in some
 * intermediate states, effectively unusable) fraction and look indistinguishable
 * from "no hit at all" during quick manual testing. There is no depth
 * constraint on this component's JSX; nest the track however reads best.
 *
 * ## KNOWN LIMITATION: scrubbing is flat-plane-only, wrong under EXPERIMENTAL curved mode
 *
 * (Code review round 2.) The dock participates in sphere-shell's
 * EXPERIMENTAL cylindrical bend (`Dock.tsx` calls `useCylindricalBend` on its
 * own group, and its in-scene "Curved" toggle can turn it on at runtime
 * regardless of `App.tsx`'s initial `curved` prop to `<WindowShell>`) - and
 * `rayToTrackFraction` always intersects the real ray against the track's
 * FLAT `matrixWorld` plane, with no bend correction. That is CORRECT for the
 * default, shipped, hardware-validated flat mode (`curved={false}`), where
 * there is no bend to correct for. It is WRONG whenever the dock is curved.
 *
 * This is a **regression for a plain click specifically** versus the
 * pre-round-1 code, which read `e.point`: uikit's own hit-testing
 * (`patchRaycastForBend` in sphere-shell) substitutes a bend-corrected ray
 * before calling the stock flat-quad raycast, so the `Intersection.point` it
 * records IS already bend-corrected - accurate for a plain click. But that
 * substitution is undone (the real ray's direction is restored) in a
 * `finally` block before any handler runs, specifically so `e.ray` stays the
 * TRUE, uncorrected ray for everyone else - which is exactly the field this
 * component now reads, for the unrelated (and more serious) reason that
 * `e.point` freezes solid during a pointer-captured drag (see
 * `timelineDrag.ts`). There is no reading of `e.ray`/`e.point` that is
 * simultaneously bend-aware AND capture-safe without doing the bend math
 * ourselves - which is exactly what a proper fix needs to do.
 *
 * **Why it isn't fixed here.** A correct fix means intersecting `e.ray`
 * against the actual CYLINDER the dock is bent onto (the analogue of
 * `useDragOnSphere` intersecting the shell sphere) and mapping the hit back
 * to this track's own local X. That cylinder's axis and radius are defined
 * in the DOCK's own bend-group local frame (`Dock.tsx`'s internal
 * `groupRef`, fed to `useCylindricalBend` - NOT the shell's `anchorRef`,
 * which is a different, unrotated ancestor: the dock sits at its own
 * `panelTransform({azimuth: 0, elevation: DOCK_ELEVATION}, ...)` offset from
 * the anchor, and a nonzero elevation TILTS the dock's local Y away from the
 * anchor's/world's vertical - so building the cylinder from `anchorRef`
 * alone would use the wrong axis orientation). Nothing sphere-shell exports
 * today reaches that group, its `matrixWorld`, or the live `BendUniforms`
 * `useCylindricalBend` computes for it, from code rendered inside the
 * `dockControls` slot - `useShellContext()` exposes only `anchorRef`, and
 * the dock's own bend transform is private to `Dock.tsx`. Reconstructing it
 * by duplicating `Dock.tsx`'s private layout constants would ALSO still be
 * short one more unknown - this track's own horizontal offset within the
 * dock's flex row, which depends on the live widths of every tile/button
 * to its left and cannot be derived without literally re-running uikit's
 * flex layout. Flagged to the task's controller as `NEEDS_CONTEXT` rather
 * than shipped as a silent approximation; see `docs/UIKIT-NOTES.md` entry 4
 * for the full ray-vs-point-vs-bend story and
 * `.superpowers/sdd/2026-08-23-opencast-player/task-13-report.md` for the
 * exact missing-API proposal.
 *
 * **Practical effect today:** in flat mode (default), scrubbing is exact.
 * In curved mode, a click/drag still moves the fill and seeks in the right
 * DIRECTION and stays monotonic, but the landed time is off by an amount
 * that grows with how far the track sits from the dock's own azimuthal
 * centre and with the bend angle - most noticeable near the track's own
 * edges. Not a crash, not a stuck/frozen preview (that specific bug is
 * fixed) - a `curved`-only numeric inaccuracy.
 */
export function DockTransport({
  store,
  seriesStore,
}: {
  store: PlayerStoreApi
  /** The ONE series-episode-list store `App.tsx` owns, shared with `SeriesWindow` - see this file's doc comment. */
  seriesStore: SeriesStateApi
}) {
  const episode = useStore(store, (s) => s.episode)
  const currentTimeS = useStore(store, (s) => s.currentTimeS)
  const seekPreviewS = useStore(store, (s) => s.seekPreviewS)
  const stalled = useStore(store, (s) => s.stalled)
  const cuesCount = useStore(store, (s) => s.cues.length)
  const subtitlesOn = useStore(store, (s) => s.subtitlesOn)
  const subtitleScale = useStore(store, (s) => s.subtitleScale)
  const subtitleOffsetDeg = useStore(store, (s) => s.subtitleOffsetDeg)
  const volume = useStore(store, (s) => s.volume)
  const muted = useStore(store, (s) => s.muted)
  const seriesEpisodes = useStore(seriesStore, (s) => s.episodes)
  const seriesHasMore = useStore(seriesStore, (s) => s.hasMore)
  const seriesLoading = useStore(seriesStore, (s) => s.loading)
  const durationS = (episode?.durationMs ?? 0) / 1000

  // Play intent comes straight from the store's own `playing` field, and this
  // button writes it through the store's `setPlaying` action - no local mirror.
  //
  // It USED to be a `useState` seeded from `engine.playing` (a plain getter, so
  // not subscribable) and reset on an episode change, which was correct only
  // while this button's own click and `openEpisode`/`toBrowse` were the only
  // writers of intent. `reportStreamError` became a fourth one (spec §9 pauses
  // the wall on a stream failure) and the mirror went stale exactly there: the
  // engine was paused, this button still showed Pause, and the user's first
  // click called `pause()` again - a no-op, so recovery took two clicks. One
  // reactive field with one writer removes the whole failure mode; see
  // `playing`'s doc comment in store.ts.
  const playing = useStore(store, (s) => s.playing)

  const togglePlay = useCallback(() => {
    const state = store.getState()
    state.setPlaying(!state.playing)
  }, [store])

  const visual = derivePlaybackVisualState(playing, stalled)
  // Known cosmetic gap (code review, fix round 1): `LoaderCircle` is a
  // static glyph here - no spin animation - so a stall reads as "a
  // different icon" rather than "loading". Animating it would need a
  // per-frame rotation on the icon's own object3D (useFrame), which is out
  // of scope for this pass; left as a follow-up, not silently unnoticed.
  const PlayPauseIcon = visual === 'play' ? Play : visual === 'loading' ? LoaderCircle : Pause

  // Non-null while dragging: shown/scrubbed instead of the real
  // `currentTimeS`, exactly as `seekPreviewS`'s own doc comment in store.ts
  // describes ("HUD feedback only") - here that HUD is this readout+fill.
  const displayTimeS = seekPreviewS ?? currentTimeS
  const fillFraction = secondsToFraction(displayTimeS, durationS)
  const { current: currentLabel, total: totalLabel } = transportTimeParts(displayTimeS, durationS)

  const trackRef = useRef<VanillaContainer | null>(null)
  // Mutable, not React state: a drag gesture's own bookkeeping (which
  // pointer, its last fraction) needs to be read-then-written synchronously
  // within a single event handler, exactly like `useDragOnSphere`'s own
  // refs - re-rendering on every intermediate move would be wasted work the
  // preview's OWN store subscription already causes anyway.
  const dragStateRef = useRef<DragState>(initialDragState)

  const resolveFraction = useCallback((e: ThreeEvent<PointerEvent>): number | null => {
    const track = trackRef.current
    if (!track) return null
    return rayToTrackFraction(e.ray.origin, e.ray.direction, track.matrixWorld)
  }, [])

  const applyEffects = useCallback(
    (effects: DragEffect[], e: ThreeEvent<PointerEvent>) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'capture':
            ;(e.target as Element).setPointerCapture?.(effect.pointerId)
            break
          case 'release':
            ;(e.target as Element).releasePointerCapture?.(effect.pointerId)
            break
          case 'preview':
            store.getState().setSeekPreview(fractionToSeconds(effect.fraction, durationS))
            break
          case 'commit':
            store.getState().engine.seek(fractionToSeconds(effect.fraction, durationS))
            break
          case 'clearPreview':
            store.getState().setSeekPreview(null)
            break
        }
      }
    },
    [store, durationS],
  )

  const onTrackPointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      // Eager and unconditional - see the doc comment above.
      e.stopPropagation()
      const fraction = resolveFraction(e)
      const { state, effects } = reduceDrag(dragStateRef.current, {
        type: 'pointerdown',
        pointerId: e.pointerId,
        fraction,
      })
      dragStateRef.current = state
      applyEffects(effects, e)
    },
    [resolveFraction, applyEffects],
  )

  const onTrackPointerMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const fraction = resolveFraction(e)
      const { state, effects } = reduceDrag(dragStateRef.current, {
        type: 'pointermove',
        pointerId: e.pointerId,
        fraction,
      })
      dragStateRef.current = state
      if (effects.length > 0) e.stopPropagation()
      applyEffects(effects, e)
    },
    [resolveFraction, applyEffects],
  )

  const onTrackPointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const fraction = resolveFraction(e)
      const { state, effects } = reduceDrag(dragStateRef.current, {
        type: 'pointerup',
        pointerId: e.pointerId,
        fraction,
      })
      dragStateRef.current = state
      if (effects.length > 0) e.stopPropagation()
      applyEffects(effects, e)
    },
    [resolveFraction, applyEffects],
  )

  const onTrackPointerCancel = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const { state, effects } = reduceDrag(dragStateRef.current, { type: 'pointercancel', pointerId: e.pointerId })
      dragStateRef.current = state
      applyEffects(effects, e)
    },
    [applyEffects],
  )

  // Every one of these writes through a store action, never through an element
  // or the engine directly - the one-writer discipline `setPlaying` established
  // (see store.ts).
  const applyVolumeStep = useCallback(
    (deltaSteps: number) => {
      const state = store.getState()
      state.setVolume(stepVolume(state.volume, deltaSteps))
    },
    [store],
  )

  const toggleMuted = useCallback(() => {
    const state = store.getState()
    state.setMuted(!state.muted)
  }, [store])

  const toggleSubtitles = useCallback(() => {
    const state = store.getState()
    state.setSubtitles(!state.subtitlesOn)
  }, [store])

  // „Vielleicht mit + und - Buttons einfach einstellbar", replacing the old
  // S/M/L cycle: one press is a constant RATIO of the current size, so it feels
  // the same at either end of the range (see ../captionScale.ts).
  const stepSize = useCallback(
    (direction: number) => {
      const state = store.getState()
      state.setSubtitleScale(stepCaptionScale(state.subtitleScale, direction))
    },
    [store],
  )

  // „Zusaetzlich ein Rauf/Runter-Button, um die Schrift in der fixierten
  // Position zu verschieben." Positive = up; `SubtitleHud` adds it to
  // <HeadLocked>'s own resting pitch.
  const stepOffset = useCallback(
    (direction: number) => {
      const state = store.getState()
      state.setSubtitleOffset(stepCaptionOffset(state.subtitleOffsetDeg, direction))
    },
    [store],
  )

  // Both window toggles below write through the SHELL store - the shell owns
  // open/closed. See `panelWindows.ts` and this file's doc comment.
  const shellStore = useShellStore()
  const seriesWindow = useWindowState(PANEL_WINDOW_IDS.series)
  const infoWindow = useWindowState(PANEL_WINDOW_IDS.info)

  const togglePanel = useCallback(
    (id: PanelWindowId, entry: { closed: boolean; minimized: boolean } | undefined) => {
      const shell = shellStore.getState()
      if (panelToggleAction(entry) === 'restore') shell.restore(id)
      else shell.close(id)
    },
    [shellStore],
  )

  const trail = useMemo(
    () => (episode ? breadcrumbTrail(episode) : []),
    [episode],
  )

  // Previous/next step through the PLAYABLE episodes of the series only - see
  // `playableEpisodes`. Both are null until the series list has actually been
  // fetched and contains the open episode, which is the honest rendering for
  // those first frames (the buttons are disabled) rather than a guess.
  const neighbours = useMemo(
    () => adjacentEpisodes(playableEpisodes(seriesEpisodes), episode?.id ?? ''),
    [seriesEpisodes, episode?.id],
  )

  // Keep paging the series until the neighbours are actually knowable - see
  // `needsMoreEpisodes` for the two silent failures this fixes (the 12th
  // recording of a 20-part series rendering as the end of it, and a recording
  // that is itself on page 2 disabling both controls forever). The predicate
  // re-evaluates on every arriving page, so this converges and then stops; it
  // holds off while a fetch is in flight, so it cannot spin.
  //
  // `lastRequestedAt` is the belt to that braces: `hasMore` is
  // `offset < total`, so a server that answers a page with ZERO episodes while
  // still claiming a larger total leaves the offset - and therefore `hasMore` -
  // exactly where they were, and the predicate would stay true forever. One
  // request per (episode, fetched-length) pair means such a page is requested
  // once and then dropped, rather than fetched in a loop for as long as the
  // dock is on screen.
  const lastRequestedAt = useRef<{ id: string; length: number } | null>(null)
  useEffect(() => {
    const id = episode?.id
    if (!id) return
    if (!needsMoreEpisodes(seriesEpisodes, id, seriesHasMore, seriesLoading)) return
    const previous = lastRequestedAt.current
    if (previous && previous.id === id && previous.length === seriesEpisodes.length) return
    lastRequestedAt.current = { id, length: seriesEpisodes.length }
    void seriesStore.getState().loadMore()
  }, [seriesStore, seriesEpisodes, episode?.id, seriesHasMore, seriesLoading])

  const openNeighbour = useCallback(
    (id: string | undefined) => {
      if (id == null) return
      // Swallowed rather than surfaced: unlike `SeriesWindow`/`LibraryWindow`,
      // the dock has no room for an error banner, and the failure mode is
      // benign - `openEpisode` rejects BEFORE tearing anything down (see its
      // doc comment), so the current episode keeps playing and the click simply
      // did nothing. The rejection is logged so it is not silent.
      store
        .getState()
        .openEpisode(id)
        .catch((err: unknown) => {
          console.error('[DockTransport] Episodenwechsel fehlgeschlagen', err)
        })
    },
    [store],
  )

  const onCrumb = useCallback(
    (crumb: Crumb) => {
      if (crumb.kind === 'current') {
        // No longer inert. „Das Fenster fuer die anderen Episoden kann ich
        // einblenden, wenn ich auf den aktuellen Episodennamen klicke" - the
        // crumb the user is already standing on is the natural place to ask
        // „what else is in this series?", and the list icon beside the label
        // says so. Nothing to toggle for a recording with no series, and the
        // crumb renders without the icon in that case.
        if (episode?.seriesId == null) return
        togglePanel(PANEL_WINDOW_IDS.series, seriesWindow)
        return
      }
      if (crumb.kind === 'home') {
        store.getState().toBrowse()
        return
      }
      if (crumb.sid == null) return // structurally impossible; breadcrumbTrail always sets it for 'series'
      // The UNtruncated series title, read from the episode rather than taken
      // from `crumb.label`: the label is cut to CRUMB_MAX_CHARS to fit the dock
      // row, and this string is what the library's level-2 header then shows -
      // where there is room for all of it. Falls back to the id exactly as
      // `breadcrumbTrail` does.
      const title = episode?.seriesTitle ?? crumb.sid
      store.getState().toBrowse({ kind: 'series', sid: crumb.sid, title })
    },
    [store, episode?.seriesTitle, episode?.seriesId, togglePanel, seriesWindow],
  )

  // Defensive only: App.tsx mounts this exclusively in player mode, which
  // always has an episode by the time `mode` flips (see store.ts's
  // `openEpisode`, which sets both in the same `set()` call).
  if (!episode) return null

  const subtitlesDisabled = cuesCount === 0
  const captionColor = subtitlesDisabled ? DISABLED_COLOR : '#ffffff'
  // Two signals for one state, on purpose: the icon says on/off at a glance
  // (a controller ray away, where a colour difference is easy to miss) and the
  // background says it too.
  const CaptionIcon = subtitlesOn && !subtitlesDisabled ? Captions : CaptionsOff
  const VolumeIcon = muted ? VolumeX : Volume2
  // Only for a recording that HAS a series: for a single recording there is no
  // list to step through, so the controls are absent rather than permanently
  // disabled (nothing the user could do would ever enable them).
  const showNeighbours = episode.seriesId != null
  // „On screen" for a panel window is neither flag set - a minimized window is
  // as absent as a closed one from where the viewer is standing, and pressing
  // the button must bring it back rather than close it again (panelToggleAction
  // decides that; this only decides how the button LOOKS).
  const infoOpen = infoWindow != null && !infoWindow.closed && !infoWindow.minimized

  const captionsActive = subtitlesOn && !subtitlesDisabled

  return (
    <Container flexDirection="row" alignItems="center" gap={8}>
      {/* Play/Pause, spanning both rows. Square and 60 px on a side - by far
          the largest target in the strip, because it is the one control a
          viewer reaches for without looking at the dock. */}
      <Container
        height={PLAY_BUTTON_PX}
        width={PLAY_BUTTON_PX}
        alignItems="center"
        justifyContent="center"
        backgroundColor="#2f6f4f"
        borderRadius={8}
        hover={{ backgroundColor: '#3f9f6f' }}
        onClick={(e) => {
          e.stopPropagation()
          togglePlay()
        }}
      >
        <PlayPauseIcon width={26} height={26} color="#ffffff" />
      </Container>

      {/* No `alignItems` override on this column: a flex column stretches its
          children by default, which is exactly what makes row 1 as wide as row
          2 and therefore lets the timeline fill the dock. See the doc comment. */}
      <Container flexDirection="column" gap={ROW_GAP_PX}>
        {/* ROW 1: the timeline, and nothing else. The time readouts stay where
            they have always been - flanking the track - at the user's explicit
            request („Die Abspielposition und Dauer koennen da bleiben wo sie
            gerade sind"). */}
        <Container height={ROW_HEIGHT_PX} flexDirection="row" alignItems="center" gap={8}>
          <Text fontSize={11} color="#cfd8ff" width={TIME_LABEL_WIDTH_PX} textAlign="right">
            {currentLabel}
          </Text>
          <Container
            ref={trackRef}
            // The one element in the row that grows: everything else here has a
            // fixed width, so the track absorbs the whole rest of the dock.
            flexGrow={1}
            minWidth={TRACK_MIN_WIDTH_PX}
            height={TRACK_HEIGHT_PX}
            borderRadius={TRACK_HEIGHT_PX / 2}
            backgroundColor="#33333d"
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerCancel}
          >
            <Container
              positionType="absolute"
              positionLeft={0}
              positionTop={0}
              // A PERCENTAGE, not `TRACK_WIDTH * fraction` px: the track no
              // longer has a width this component knows - it is whatever row 1
              // had left over. uikit accepts a `${n}%` string and resolves it
              // against the parent's laid-out box, so the fill stays correct at
              // any dock width, including on the first frame before the strip
              // has settled.
              width={`${Math.round(fillFraction * 1000) / 10}%`}
              height={TRACK_HEIGHT_PX}
              borderRadius={TRACK_HEIGHT_PX / 2}
              backgroundColor="#6f9fff"
              pointerEvents="none"
            />
          </Container>
          <Text fontSize={11} color="#cfd8ff" width={TIME_LABEL_WIDTH_PX}>
            {totalLabel}
          </Text>
        </Container>

        {/* ROW 2: where you are, the neighbouring recordings, and every
            remaining control. */}
        <Container flexDirection="row" alignItems="center" gap={4}>
          {trail.map((crumb, index) => {
            // The last crumb is no longer inert: it opens (and closes) the
            // Reihe window, and says so with a list icon. Only when there IS a
            // series - for a single recording it stays a plain label.
            const opensSeries = crumb.kind === 'current' && showNeighbours
            const interactive = crumb.kind !== 'current' || opensSeries
            return (
              // `kind` is unique within a trail (one home, at most one series,
              // one current - see breadcrumbTrail), so it is a stable key.
              <Container key={crumb.kind} flexDirection="row" alignItems="center" gap={4}>
                {index > 0 && <ChevronRight width={11} height={11} color="#5a5a65" />}
                <Container
                  height={CRUMB_ROW_HEIGHT_PX}
                  paddingX={6}
                  gap={4}
                  flexDirection="row"
                  alignItems="center"
                  borderRadius={4}
                  backgroundColor="#22222c"
                  // A non-interactive crumb keeps its resting colour on hover.
                  // Always a present object - never `undefined` - per
                  // docs/UIKIT-NOTES.md entry 1.
                  hover={{ backgroundColor: interactive ? '#2f3a4f' : '#22222c' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCrumb(crumb)
                  }}
                >
                  {crumb.kind === 'home' && <House width={11} height={11} color={CRUMB_COLOR} />}
                  <Text
                    fontSize={11}
                    color={crumb.kind === 'current' ? CRUMB_CURRENT_COLOR : CRUMB_COLOR}
                  >
                    {crumb.label}
                  </Text>
                  {/* „Bitte ein passendes Symbol da noch einblenden, dass man
                      merkt, dass eine Aktion da verbunden ist." A list icon,
                      because what it opens IS the list of the other episodes -
                      and it is drawn in the brighter crumb colour, so the
                      affordance reads even where the greyed label does not. */}
                  {opensSeries && <List width={11} height={11} color={CRUMB_COLOR} />}
                </Container>
              </Container>
            )
          })}

          {showNeighbours && (
            <Container flexDirection="row" alignItems="center" gap={4} marginLeft={4}>
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={neighbours.previous == null}
                onPress={() => openNeighbour(neighbours.previous?.id)}
              >
                <SkipBack
                  width={SMALL_ICON_PX}
                  height={SMALL_ICON_PX}
                  color={neighbours.previous == null ? DISABLED_COLOR : '#ffffff'}
                />
              </IconButton>
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={neighbours.next == null}
                onPress={() => openNeighbour(neighbours.next?.id)}
              >
                <SkipForward
                  width={SMALL_ICON_PX}
                  height={SMALL_ICON_PX}
                  color={neighbours.next == null ? DISABLED_COLOR : '#ffffff'}
                />
              </IconButton>
            </Container>
          )}

          <Container width={1} height={18} backgroundColor="#33333d" marginX={4} />

          {/* Captions: on/off, and - only while they are actually showing -
              size and vertical position. „Die Buttons nur eingeblendet, wenn
              die Untertitel aktiviert sind": four controls that change nothing
              visible with the captions off would be four ways to wonder whether
              the dock is broken. */}
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            background={captionsActive ? ACTIVE_BG : BUTTON_BG}
            hoverBackground={captionsActive ? ACTIVE_BG_HOVER : BUTTON_BG_HOVER}
            disabled={subtitlesDisabled}
            onPress={toggleSubtitles}
          >
            <CaptionIcon width={SMALL_ICON_PX} height={SMALL_ICON_PX} color={captionColor} />
          </IconButton>
          {captionsActive && (
            <Container flexDirection="row" alignItems="center" gap={4}>
              <ALargeSmall width={SMALL_ICON_PX} height={SMALL_ICON_PX} color="#cfd8ff" />
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={subtitleScale <= MIN_CAPTION_SCALE}
                onPress={() => stepSize(-1)}
              >
                <Minus
                  width={SMALL_ICON_PX}
                  height={SMALL_ICON_PX}
                  color={subtitleScale <= MIN_CAPTION_SCALE ? DISABLED_COLOR : '#ffffff'}
                />
              </IconButton>
              {/* Fixed width, same reason as the volume readout: „100%" ->
                  „112%" must not shove the rest of the row sideways - and in
                  the dock, resize the whole strip - on every press. */}
              <Text fontSize={11} color="#cfd8ff" width={34} textAlign="center">
                {captionScaleLabel(subtitleScale)}
              </Text>
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={subtitleScale >= MAX_CAPTION_SCALE}
                onPress={() => stepSize(1)}
              >
                <Plus
                  width={SMALL_ICON_PX}
                  height={SMALL_ICON_PX}
                  color={subtitleScale >= MAX_CAPTION_SCALE ? DISABLED_COLOR : '#ffffff'}
                />
              </IconButton>
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={subtitleOffsetDeg >= MAX_CAPTION_OFFSET_DEG}
                onPress={() => stepOffset(1)}
              >
                <ChevronUp
                  width={SMALL_ICON_PX}
                  height={SMALL_ICON_PX}
                  color={subtitleOffsetDeg >= MAX_CAPTION_OFFSET_DEG ? DISABLED_COLOR : '#ffffff'}
                />
              </IconButton>
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={subtitleOffsetDeg <= MIN_CAPTION_OFFSET_DEG}
                onPress={() => stepOffset(-1)}
              >
                <ChevronDown
                  width={SMALL_ICON_PX}
                  height={SMALL_ICON_PX}
                  color={subtitleOffsetDeg <= MIN_CAPTION_OFFSET_DEG ? DISABLED_COLOR : '#ffffff'}
                />
              </IconButton>
            </Container>
          )}

          <Container width={1} height={18} backgroundColor="#33333d" marginX={4} />

          {/* Audio: mute, then volume in 10% steps. The percentage stays visible
              while muted (greyed) rather than being replaced by "-" - it is the
              level unmuting will come back to, which is exactly what someone
              reaching for the volume while muted wants to know. */}
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            background={muted ? ACTIVE_BG : BUTTON_BG}
            hoverBackground={muted ? ACTIVE_BG_HOVER : BUTTON_BG_HOVER}
            onPress={toggleMuted}
          >
            <VolumeIcon width={SMALL_ICON_PX} height={SMALL_ICON_PX} color="#ffffff" />
          </IconButton>
          <IconButton size={CRUMB_ROW_HEIGHT_PX} disabled={volume <= 0} onPress={() => applyVolumeStep(-1)}>
            <Minus width={SMALL_ICON_PX} height={SMALL_ICON_PX} color={volume <= 0 ? DISABLED_COLOR : '#ffffff'} />
          </IconButton>
          <Text fontSize={11} color={muted ? DISABLED_COLOR : '#cfd8ff'} width={30} textAlign="center">
            {`${volumeToPercent(volume)}%`}
          </Text>
          <IconButton size={CRUMB_ROW_HEIGHT_PX} disabled={volume >= 1} onPress={() => applyVolumeStep(1)}>
            <Plus width={SMALL_ICON_PX} height={SMALL_ICON_PX} color={volume >= 1 ? DISABLED_COLOR : '#ffffff'} />
          </IconButton>

          {/* „Einen i/Info-Button im Dock zum Anzeigen der Infos." The Info
              window starts closed like the other panels, so this button and its
              dock tile are the two ways to it; pressing it again puts it away.
              Lit like an active toggle while the window is on screen, which is
              what makes the second press predictable. */}
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            background={infoOpen ? ACTIVE_BG : BUTTON_BG}
            hoverBackground={infoOpen ? ACTIVE_BG_HOVER : BUTTON_BG_HOVER}
            onPress={() => togglePanel(PANEL_WINDOW_IDS.info, infoWindow)}
          >
            <Info width={SMALL_ICON_PX} height={SMALL_ICON_PX} color="#ffffff" />
          </IconButton>
        </Container>
      </Container>
    </Container>
  )
}
