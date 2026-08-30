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
  ScrollText,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from '@react-three/uikit-lucide'
import {
  DECORATIVE_POINTER_EVENTS,
  HoverLabel,
  useDockBendFrame,
  useShellStore,
  useWindowState,
  useXRSession,
} from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import type { SeriesStateApi } from './seriesState'
import {
  PANEL_WINDOW_IDS,
  panelToggleAction,
  panelWindowAvailable,
  type PanelWindowId,
} from './panelWindows'
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
  rayToTrackFractionCurved,
  reduceDrag,
} from './timelineDrag'
import { segmentTickFractions } from './chaptersState'
import { TOUR_CONTROL_IDS, type TourControlId, type TourStep } from './tourSteps'
import { TourBubble, TOUR_PANEL_WIDTH_PX } from './TourBubble'
import { useCapturedPress } from './useCapturedPress'

const BUTTON_ICON_PX = 15
const SMALL_ICON_PX = 13
const TRACK_HEIGHT_PX = 6
/**
 * Chapter tick marks on the track - see the row 1 JSX below for how they're
 * positioned.
 *
 * Widened from the original 2px („Hattest du die Kapitelmarken und Preview
 * Bilder in der Timeline noch nicht aktiviert?" - the user looked for them on
 * a real recording and found nothing). Live pixel measurement during this
 * task's diagnosis (`gl.readPixels` against the actual rendered track, a
 * segmented test recording, desktop/magic-window view) found the ticks WERE
 * rendering at the mathematically correct blended colour - but at 2px wide
 * they occupied only 2-3 real screen pixels at an ordinary viewing distance,
 * i.e. they were there but essentially sub-pixel. The bigger factor turned
 * out to be data, not rendering (most real Opencast recordings, including
 * every one of 350 sampled from oc.explore.opencast.org's own search API,
 * carry no `segments` at all - see this file's own doc comment section below
 * and `chaptersState.ts`), but a tick that IS present being this easy to miss
 * is worth fixing regardless of that. 3px is still a thin sliver relative to
 * the track's own height, not a fat notch, but roughly 50% more surface area
 * to catch the eye - and, through a headset lens (softening + some chromatic
 * aberration), the couple of extra physical pixels matter more than they do
 * on a flat desktop screenshot.
 */
const TICK_WIDTH_PX = 3
/**
 * Semi-transparent white, not a solid colour: the ticks have to read against
 * BOTH the dark unplayed track (`#33333d`) and the lighter blue played fill
 * (`#6f9fff`) they sit on top of - see row 1's JSX for the stacking order. A
 * translucent white lightens whichever backdrop is under it rather than
 * fighting either one outright, so one colour value works on both without a
 * mix-blend-mode uikit does not have.
 *
 * Raised from 0.55 alongside `TICK_WIDTH_PX` above, for the same reason:
 * measured live, a 0.55-opacity tick over the unplayed track blends to
 * `rgb(163,163,167)` (against the track's own `rgb(51,51,61)` - a real
 * ~110/255 per-channel difference, not actually weak) but over the BLUE
 * fill bar (`rgb(111,159,255)`) the same math blends to
 * `rgb(190,212,255)` - only ~50-80/255 per channel, and all three channels
 * moving the same direction as the backdrop rather than away from it, which
 * reads as barely-there. 0.85 keeps the "lighten, don't fight" blend this
 * constant's own doc comment describes while giving the fill-bar case
 * noticeably more separation too.
 */
const TICK_COLOR = '#ffffff'
const TICK_OPACITY = 0.85
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

/**
 * The width of this whole control block, in the dock's design pixels - and
 * therefore, near enough, the width of the dock itself.
 *
 * ## Why the app names a number here
 *
 * sphere-shell's dock is content-sized: since it became two strips (tiles above,
 * controls below - see `Dock.tsx`), the control strip holds nothing but this
 * slot, a 2 px divider and two 30 px square buttons. So whatever width this
 * container takes IS the dock's width, and „die Zeitleisten-Zeile spannt über
 * die GESAMTE Dock-Breite" becomes a question the app has to answer: how wide
 * should the dock be?
 *
 * Sizing to content instead - the previous round's approach - cannot answer it.
 * The column would be exactly as wide as row 2's controls, so the timeline
 * would only ever get what those left over, and the dock's width would twitch
 * with the breadcrumb's text and with whether captions are on.
 *
 * ## Where 1100 comes from
 *
 * uikit's design pixels map to a fixed angular size in this dock:
 * `Dock.tsx` derives `pixelSize` from ONE tile's angular width, so a design
 * pixel is the same fraction of a degree at any shell radius. At the shipped
 * radius this block plus the shell's own controls lands at about **65° of
 * azimuth** - just under the 64°-wide video window it sits below, and well
 * inside the ~±55° comfortable arc (the dock spans ±32.5°).
 *
 * ## Why it cannot be too small
 *
 * uikit's flex children do not shrink, so a width below row 2's own content
 * would push that row out past the dock's background rather than compressing
 * it. Row 2's worst case is bounded: both breadcrumb labels are truncated to
 * `CRUMB_MAX_CHARS` (30) by `breadcrumbState.ts`, which puts the row at roughly
 * 900 px with every control showing - about 130 px inside the 1032 px this
 * leaves for the column. Raising `CRUMB_MAX_CHARS` or adding another control to
 * row 2 is what would eat that margin.
 */
const SLOT_WIDTH_PX = 1100

const BUTTON_BG = '#2c2c3a'
const BUTTON_BG_HOVER = '#3a3a4a'
const ACTIVE_BG = '#2f4f6f'
const ACTIVE_BG_HOVER = '#3f6f9f'
const DISABLED_COLOR = '#5a5a65'
const CRUMB_COLOR = '#cfd8ff'
const CRUMB_CURRENT_COLOR = '#9a9aa5'

/**
 * The tutorial tour's "look here" style - see `IconButton`'s `highlighted`
 * prop and this file's `isHighlighted`/`TOUR_GAP_PX` below. A warm amber,
 * deliberately far from every other colour already in this dock (the blues of
 * `ACTIVE_BG`/`CRUMB_COLOR`, the green of the Play/Pause button, the reds
 * nowhere in this file at all) so a highlighted control cannot be mistaken
 * for an already-active toggle.
 */
const TOUR_HIGHLIGHT_BG = '#5a4a1f'
const TOUR_HIGHLIGHT_BORDER = '#ffcf4d'
/** Gap between the dock's own control strip and the tour bubble sitting above it. */
const TOUR_GAP_PX = 14

/**
 * Extra width sphere-shell's OWN control strip adds beyond this component's
 * own `SLOT_WIDTH_PX` slot - see the tour bubble's own JSX comment below for
 * why the bubble has to know about it to center over the REAL dock rather
 * than just this app's own slot within it („Das Tutorial bitte Mittig dann
 * über dem Dock").
 *
 * Not exported by sphere-shell - `Dock.tsx`'s own `BUTTON_PX`/`MENU_WIDTH_PX`
 * are module-private - so these two numbers are measured directly from the
 * installed `sphere-shell/dist/index.js` instead: the control strip is ONE
 * `flexDirection: "row", gap: 8` container whose children are `[this app's
 * slot, a 2px divider, the three-dot menu group, xrSession.active && the Exit
 * VR button]` - four siblings of that SAME row, not three with the exit
 * button nested inside the menu group (an easy misread the first pass here
 * made - the exit `<HoverLabel>` sits at the same JSX level as the menu
 * group's own closing `] })`, one `children` entry further along). `gap: 8`
 * applies between every consecutive pair, so the shell's own three-dot MENU
 * button (a fixed 30px square, ALWAYS present) costs one 8px gap plus its
 * own 30px; `SHELL_EXTRA_XR_PX` is the Exit VR button, which costs a SECOND
 * 8px gap (the new gap its own appearance inserts before it) on top of ITS
 * 30px - 38, not merely its own width - and only applies while
 * `xrSession.active` (see that file's own `Dock` component).
 *
 * This is an approximation of an unexported internal, not a contract: if a
 * future sphere-shell release changes either number, the bubble goes back to
 * being slightly off-center rather than broken outright - a cosmetic
 * regression, not a functional one.
 */
const SHELL_EXTRA_BASE_PX = 8 + 2 + 8 + 30 // gap + divider + gap + the shell's own menu button
const SHELL_EXTRA_XR_PX = 8 + 30 // one more gap + the Exit VR button, present only in an active XR session

/**
 * What each icon-only control's hover label says („Sind Tooltipps möglich wenn
 * man auf die Buttons zeigt?" - yes, this is them).
 *
 * Collected here rather than inlined at fifteen call sites: they are the only
 * user-facing copy in this file that is not derived from data, so having them in
 * one block is what makes them reviewable as a set - consistent voice, no two
 * buttons claiming the same thing, and every one of them checkable against the
 * uikit font's own limits in a single glance.
 *
 * Umlauts are deliberate and safe: this uikit version renders accented Latin
 * letters (Task 11 verified it live against the real server); what it cannot
 * draw is typographic PUNCTUATION - no ellipsis, no en dash, no middle dot. See
 * `docs/UIKIT-NOTES.md` entry 3.
 *
 * A label names the ACTION where pressing does something ("Stumm", "Weiter"),
 * and the STATE it will move to where the control is a toggle ("Ton an" while
 * muted) - the same rule the shell's own Curved/Flat button follows, and the
 * only one that answers "what happens if I press this".
 */
const LABEL = {
  play: 'Wiedergabe',
  pause: 'Pause',
  previousEpisode: 'Vorherige Aufzeichnung',
  nextEpisode: 'Nächste Aufzeichnung',
  captionsOn: 'Untertitel an',
  captionsOff: 'Untertitel aus',
  captionSmaller: 'Schrift kleiner',
  captionLarger: 'Schrift größer',
  captionUp: 'Schrift höher',
  captionDown: 'Schrift tiefer',
  mute: 'Stumm',
  unmute: 'Ton an',
  volumeDown: 'Leiser',
  volumeUp: 'Lauter',
  transcript: 'Transkript',
  info: 'Infos',
} as const

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
 *
 * ## The icon is wrapped in a hit-transparent layer, and that is load-bearing
 *
 * These are the smallest targets in the app - 24 px squares holding a 13 px
 * lucide icon - and the icon is its own `Object3D` (one per SVG subpath, in
 * fact). `@pmndrs/pointer-events` emits a `click` only when pointerdown and
 * pointerup resolve to the EXACT same object, with no movement tolerance
 * whatsoever, while `hover` is emitted on the hit object and all its ancestors.
 * So a press landing on the glyph and a release landing on the ~5 px of button
 * around it is not a click - and the button was lit the whole time. That is a
 * precise match for the user's „Im VR lösen die Buttons nicht immer aus ...
 * auch wenn sie durch das Zielen mit dem Controller schon gehighlighted sind".
 *
 * Wrapping the children in a `pointerEvents="none"` layer (inherited, so it
 * covers whatever the caller passed and every mesh inside it) collapses the
 * button back to one hit object. Done here rather than at each of the fifteen
 * call sites for the same reason the `hover` object is: one helper is how it
 * stays applied. See sphere-shell's `DECORATIVE_POINTER_EVENTS` for the quoted
 * upstream code, and `XR_CLICK_THRESHOLD_MS` for the other, larger half of the
 * same report.
 *
 * ## Every one of them carries a hover label, and `label` is REQUIRED
 *
 * „Sind Tooltipps möglich wenn man auf die Buttons zeigt?" - yes, via
 * sphere-shell's `<HoverLabel>`, and this is where they go: a button in this row
 * is a 24 px square holding a 13 px glyph, read at arm's length through a lens,
 * so the icon alone is a guess for anything but Play/Pause. The prop is
 * mandatory rather than optional so that adding a control to this row cannot
 * quietly ship without one - the compiler asks.
 *
 * `labelAlign` exists for the same reason `HoverLabel` has it: a label grows
 * rightward from its button by default, which is wrong for the buttons at the
 * right-hand end of the row, where it would hang off the dock. See the call
 * sites.
 *
 * ## `highlighted` - the tutorial tour's "look here"
 *
 * True for exactly the controls the tour's CURRENT step is explaining (see
 * `tourSteps.ts`'s `TourStep.highlightIds` and this file's own
 * `isHighlighted`). Encoded the same defensive way as the disabled-hover
 * trap this component's doc comment already describes: `background` and
 * `borderColor` are always concrete values, never conditionally `undefined`,
 * with "not highlighted" spelled as `borderWidth={0}` and a border colour
 * equal to the resting background - never by omitting the prop (see
 * `docs/UIKIT-NOTES.md` entry 1, which is about `hover` specifically but the
 * same "never toggle a prop to/from `undefined`" caution is applied here on
 * principle).
 *
 * ## Pointer-captured press, not `onClick` - the jitter fix
 *
 * „Mit den Zeigern der Quest zittere ich immer ein wenig, dann kann aus einem
 * Button Drücken ein verschieben werden": a press that drifts off this 24px
 * square before release used to be lost outright (`onClick` needs the same
 * `Object3D` at both ends - `docs/UIKIT-NOTES.md` entry 6b). `useCapturedPress`
 * (`pressCapture.ts`'s reducer, wired thin) captures the pointer on
 * `pointerdown` so the release always resolves back to THIS button
 * regardless of where the ray has wandered to by then - see that module's own
 * doc comment for why release-anywhere-while-captured is the right behaviour
 * here (matching a physical button) rather than a distance-based cancel.
 */
function IconButton({
  size = ROW_HEIGHT_PX,
  background = BUTTON_BG,
  hoverBackground = BUTTON_BG_HOVER,
  disabled = false,
  highlighted = false,
  label,
  labelAlign = 'left',
  onPress,
  children,
}: {
  size?: number
  background?: string
  hoverBackground?: string
  disabled?: boolean
  /** True while the tutorial tour is pointing at this control - see the doc comment above. */
  highlighted?: boolean
  /** What the hover label says. German, plain ASCII-safe text - see the doc comment. */
  label: string
  /** `'right'` for a button near the end of the row, so its label grows inward. */
  labelAlign?: 'left' | 'right'
  onPress: () => void
  children: ReactNode
}) {
  const restingBackground = highlighted ? TOUR_HIGHLIGHT_BG : background
  const hoveredBackground = highlighted ? TOUR_HIGHLIGHT_BG : hoverBackground
  const press = useCapturedPress(onPress, disabled)
  return (
    <HoverLabel label={label} controlHeight={size} align={labelAlign}>
      <Container
        width={size}
        height={size}
        alignItems="center"
        justifyContent="center"
        backgroundColor={restingBackground}
        borderRadius={6}
        borderWidth={highlighted ? 2 : 0}
        borderColor={highlighted ? TOUR_HIGHLIGHT_BORDER : restingBackground}
        hover={{ backgroundColor: disabled ? restingBackground : hoveredBackground }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerCancel={press.onPointerCancel}
      >
        {/* See the doc comment: the icon must not be a hit target of its own.
            `alignItems`/`justifyContent` are inherited from nothing - this layer
            has to centre its own child, since it is now the box between the
            button and the icon. */}
        <Container
          alignItems="center"
          justifyContent="center"
          pointerEvents={DECORATIVE_POINTER_EVENTS}
        >
          {children}
        </Container>
      </Container>
    </HoverLabel>
  )
}

/**
 * One breadcrumb crumb - a real component, not inline JSX inside the
 * `trail.map()` below, for the same reason `MediaList.tsx`'s `MediaListRow`
 * is one: `useCapturedPress` is a hook, and hooks cannot be called from
 * inside a loop callback. One row per trail entry, keyed by `crumb.kind` at
 * the call site (stable - see `breadcrumbTrail`'s own doc comment: one home,
 * at most one series, one current), gives each crumb its own hook state
 * exactly like any other list of components.
 *
 * `disabled={!interactive}` - not just leaving `onCrumb` to no-op for a
 * non-interactive crumb (the current-recording crumb of a series-less
 * episode) - keeps `useCapturedPress`'s own "disabled buttons never capture"
 * contract true here too: an inert crumb's `pointerdown` doesn't grab the
 * pointer at all, matching every other disabled control in this file.
 */
function CrumbRow({
  crumb,
  showChevron,
  interactive,
  opensSeries,
  onPress,
}: {
  crumb: Crumb
  /** Every crumb after the first gets a `ChevronRight` separator before it. */
  showChevron: boolean
  interactive: boolean
  /** Whether THIS crumb (always the current-recording one when true) shows the "opens a list" icon. */
  opensSeries: boolean
  onPress: () => void
}) {
  const press = useCapturedPress(onPress, !interactive)
  return (
    <Container flexDirection="row" alignItems="center" gap={4}>
      {showChevron && <ChevronRight width={11} height={11} color="#5a5a65" />}
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
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerCancel={press.onPointerCancel}
      >
        {/* All three children hit-transparent: a crumb is one
            button, and its label covers nearly all of it. See
            `IconButton`'s doc comment. */}
        {crumb.kind === 'home' && (
          <House
            width={11} height={11} color={CRUMB_COLOR}
            pointerEvents={DECORATIVE_POINTER_EVENTS}
          />
        )}
        <Text
          fontSize={11}
          color={crumb.kind === 'current' ? CRUMB_CURRENT_COLOR : CRUMB_COLOR}
          pointerEvents={DECORATIVE_POINTER_EVENTS}
        >
          {crumb.label}
        </Text>
        {/* „Bitte ein passendes Symbol da noch einblenden, dass man
            merkt, dass eine Aktion da verbunden ist." A list icon,
            because what it opens IS the list of the other episodes -
            and it is drawn in the brighter crumb colour, so the
            affordance reads even where the greyed label does not. */}
        {opensSeries && (
          <List
            width={11} height={11} color={CRUMB_COLOR}
            pointerEvents={DECORATIVE_POINTER_EVENTS}
          />
        )}
      </Container>
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
 * ## How the timeline gets „die gesamte Breite"
 *
 * Three nested facts, and the first one is the library's:
 *
 * 1. sphere-shell's dock is now TWO strips - the window tiles on their own row
 *    above, the controls below - so this slot no longer shares its row with the
 *    tiles, and the only other things beside it are a 2 px divider and two
 *    30 px square buttons. Whatever width this container takes is, near enough,
 *    the dock's width.
 * 2. This container takes `SLOT_WIDTH_PX` (see that constant for where the
 *    number comes from and why the app has to name one at all), and the column
 *    of two rows takes all of it except the Play/Pause square, via `flexGrow`.
 * 3. Inside that column, row 1 is as wide as the column - a flex column's
 *    default `alignItems` is `stretch` - and the TRACK alone carries
 *    `flexGrow={1}`, so it absorbs everything row 1 does not spend on the two
 *    fixed-width time readouts.
 *
 * The previous round sized this block to its own CONTENT instead. That was the
 * right answer while the tiles shared the row - a constant would have been
 * fighting them for width, and losing more of it with every window the user put
 * away - and the wrong one now: content-sizing means row 1 can only be as wide
 * as row 2's controls happen to be, which measured at 60 % of the dock. The
 * cost of naming a width is that uikit's flex children do not shrink; see
 * `SLOT_WIDTH_PX` for the bound that keeps row 2 inside it.
 *
 * What the track still does NOT cover is the Play/Pause square, the two time
 * readouts and the shell's own two buttons - all of them controls rather than
 * dead space. Covering those as well would mean the timeline being a full-bleed
 * row of the DOCK in its own right, which contradicts „Nur der Play/Pause
 * Button sollte beide Zeilen ueberspannen": a row 1 that spans the whole dock
 * leaves nothing beside it for the button to span.
 *
 * ## Two rows inside the dock's control strip
 *
 * That strip is a `flexDirection="row"` uikit Container with
 * `alignItems="center"` and no fixed height, and the app's slot is one child of
 * it. So a slot child that is itself a `flexDirection="column"` simply becomes
 * a taller row item and the dock grows to fit it - and the shell's own controls
 * stay vertically centred beside it. Verified live (screenshot + measured dock
 * height) rather than assumed.
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
 * ## CLOSED: exact curved-mode scrubbing via sphere-shell 0.3.1's `useDockBendFrame()`
 *
 * (Was a KNOWN LIMITATION through the curved-default round; closed once the
 * library shipped the missing API this doc comment used to ask for.) The
 * dock participates in sphere-shell's EXPERIMENTAL cylindrical bend
 * (`Dock.tsx` calls `useCylindricalBend` on its own group; its in-scene
 * "Curved"/"Flat" row can flip curvature at runtime independent of
 * `App.tsx`'s `curved` prop, in either direction), and a flat-plane ray/track
 * intersection alone - `rayToTrackFraction` - is only exact while the dock is
 * actually rendered flat. Under curved rendering it is off by
 * `R·(tan k − k)` (`flatXForBentX`'s derivation), growing with the offset
 * from the dock's own bend axis - worst case on the order of ~6.4% of the
 * full timeline near a track's edge.
 *
 * **The fix.** sphere-shell 0.3.1 added `useDockBendFrame()`, exactly the
 * export this doc comment used to ask for: called from `dockControls` (this
 * component), it hands back the dock's own live bend group, its bend radius
 * in both metres and uikit layout pixels, `pixelSize` (the conversion factor
 * between them), and `curved` - the dock's RENDERED state, not the nominal
 * prop, derived together with the other four fields in one `useMemo` so they
 * can never disagree (see the hook's own doc comment and the README's
 * "Curved windows (experimental)" section for the worked recipe). `resolveFraction`
 * above reads it once per pointer event and, whenever `bendFrame.curved` is
 * true and its group has mounted, calls `rayToTrackFractionCurved`
 * (`timelineDrag.ts`) instead of the flat `rayToTrackFraction` - which
 * intersects the same flat plane (the flat-plane hit is still exactly what a
 * real ray aimed at the curved surface reports, per the README's derivation)
 * and then undoes the bend, `x_true = R·atan(x_flat / R)`, in the SAME unit
 * (`bendRadiusPx` in pixels) the track's own width is laid out in, before
 * turning the corrected offset into a fraction between the track's own
 * (bend-invariant, since bending preserves arc length) edges. See
 * `rayToTrackFractionCurved`'s own doc comment in `timelineDrag.ts` for the
 * full step-by-step and why the correction has to run in the DOCK's frame,
 * not the track's own.
 *
 * Flat mode is untouched: `resolveFraction` falls back to the exact,
 * unchanged `rayToTrackFraction` whenever `bendFrame.curved` is false (flat
 * rendering, or `curvedAvailable` having forced it off under the app) or the
 * bend group hasn't mounted yet, so nothing about the flat path's behaviour
 * or its own tests changed.
 *
 * Verified independently, not just implementation-vs-itself:
 * `timelineDrag.test.ts`'s `rayToTrackFractionCurved` suite constructs a
 * known fraction's TRUE 3D position via sphere-shell's own exported
 * `bendPoint` (the library's forward bend map), builds a real ray from the
 * anchor through it, intersects that ray against the flat track plane by
 * hand, and confirms `rayToTrackFractionCurved` recovers the original
 * fraction - across an identity bend group, a translated/scaled one, a
 * non-1 `pixelSize`, and a near-edge fraction - without ever calling the
 * `Math.atan` correction the production code itself uses to derive its
 * expectations.
 *
 * The upstream, library-level limitations the README still names for curved
 * mode remain out of this component's scope: hand/touch (`spherecast`)
 * hit-testing is not bend-corrected (ray pointers, which is what this
 * track's own pointer handlers are, are), and this fix does not change that.
 *
 * ## Chapter tick marks, and hover (not just drag) seek-preview
 *
 * „Können wir die Kapitelmarken wenn verfügbar noch in der Zeitleiste
 * anzeigen und wenn man drüber hoovert auch das passende Vorschaubild?" - two
 * additions, both built on the SAME `segments`/`seekPreviewS` seam this
 * component already had:
 *
 * 1. A thin tick mark per INTERIOR segment boundary
 *    (`chaptersState.ts`'s `segmentTickFractions` - deliberately reused
 *    rather than a second segment-lookup module, per that file's own doc
 *    comment) is drawn on top of the track, AFTER the fill bar in JSX order
 *    so it stays visible against both the played and unplayed portions (see
 *    `TICK_COLOR`). Every tick carries `DECORATIVE_POINTER_EVENTS`, exactly
 *    like the fill bar beside it, so the track stays the single hit object
 *    this whole component's drag math depends on.
 * 2. `onTrackPointerMove` now branches on `dragStateRef.current.dragging`:
 *    while NO drag is in progress, a hover move writes `setSeekPreview`
 *    directly (bypassing `reduceDrag`, whose own foreign-pointer rejection
 *    is a DRAG-gesture concern that does not apply to a plain hover), and
 *    `onTrackPointerLeave` clears it again - guarded the same way, so a
 *    captured drag's own pointerup/pointercancel effects remain the only way
 *    an in-progress drag's preview is cleared. This was wired up (rather
 *    than shipped drag-only) because plain hover-without-press pointer
 *    callbacks are already proven reliable in this exact stack: sphere-shell's
 *    `HoverLabel` - every one of this dock's fifteen button tooltips - is
 *    driven entirely by `onPointerEnter`/`onPointerLeave` firing with no
 *    press involved (`IconButton`'s own doc comment), which is the same
 *    `@pmndrs/pointer-events` hover machinery this track's `onPointerMove`
 *    rides on.
 *
 * `seekPreviewS` already fed `SubtitleHud.tsx`'s scrub-feedback readout
 * (time + chapter title); that same value now also carries the matching
 * segment's preview image, so hovering (or dragging) the track shows it
 * there with no new plumbing between this component and that one - see
 * `subtitleHudState.ts`'s `seekFeedback` and `SubtitleHud.tsx`'s own doc
 * comment for the rest of that path.
 */
/** What `App.tsx` hands down to run the tutorial tour - absent entirely (`undefined`) whenever no tour is active, which is the ordinary case (see `tourGate.ts`). */
export interface DockTransportTour {
  step: TourStep
  stepNumber: number
  stepCount: number
  isLast: boolean
  onAdvance: () => void
  onSkip: () => void
}

export function DockTransport({
  store,
  seriesStore,
  tour,
}: {
  store: PlayerStoreApi
  /** The ONE series-episode-list store `App.tsx` owns, shared with `SeriesWindow` - see this file's doc comment. */
  seriesStore: SeriesStateApi
  /** The tutorial tour's current step, or `undefined` while no tour is running - see `App.tsx`'s own tour wiring (`tourState.ts`/`tourGate.ts`) and `TourBubble.tsx`. */
  tour?: DockTransportTour
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

  // Pointer-captured press, not `onClick` - see `pressCapture.ts`'s doc
  // comment. This is the button the whole jitter fix was motivated by (the
  // biggest target in the app, and the one a viewer reaches for without
  // looking) - it has no `disabled` state to preserve (it toggles intent
  // regardless of `stalled`; the spinner above is purely `PlayPauseIcon`'s
  // own visual, untouched by this).
  const playPress = useCapturedPress(togglePlay)

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

  // Chapter tick marks - see `segmentTickFractions`'s own doc comment for
  // exactly which boundaries qualify (interior ones only). `[]` whenever the
  // episode has no segments, which is most of develop.opencast.org's own
  // recordings - the row 1 JSX below simply renders nothing extra then.
  const tickFractions = useMemo(
    () => segmentTickFractions(episode?.segments ?? [], episode?.durationMs ?? 0),
    [episode?.segments, episode?.durationMs],
  )

  const trackRef = useRef<VanillaContainer | null>(null)
  // Mutable, not React state: a drag gesture's own bookkeeping (which
  // pointer, its last fraction) needs to be read-then-written synchronously
  // within a single event handler, exactly like `useDragOnSphere`'s own
  // refs - re-rendering on every intermediate move would be wasted work the
  // preview's OWN store subscription already causes anyway.
  const dragStateRef = useRef<DragState>(initialDragState)

  // sphere-shell 0.3.1's own bend frame for THIS dock instance - see
  // `rayToTrackFractionCurved`'s doc comment in `timelineDrag.ts` for what
  // each field is and why the correction needs all of them together.
  const bendFrame = useDockBendFrame()

  // Whether an XR session is currently active - the ONLY reactive input the
  // tour bubble's centering needs from the shell (see `SHELL_EXTRA_XR_PX`'s
  // doc comment: the shell's Exit VR button, and therefore the dock's real
  // width, only exists while this is true).
  const xrSession = useXRSession()

  const resolveFraction = useCallback(
    (e: ThreeEvent<PointerEvent>): number | null => {
      const track = trackRef.current
      if (!track) return null
      // `bendFrame.curved` is the dock's RENDERED state (not merely the prop
      // `App.tsx` asked for - see `useDockBendFrame`'s own doc comment on why
      // that distinction matters and why it can be trusted directly). Every
      // other field is non-null exactly when this is true; the `?? null`
      // guards are defensive only - `curved` and the rest are derived
      // together in the library's own single `useMemo`, so they cannot
      // actually disagree.
      const group = bendFrame.group?.current
      if (bendFrame.curved && group && bendFrame.bendRadiusPx != null && bendFrame.pixelSize != null) {
        return rayToTrackFractionCurved(
          e.ray.origin,
          e.ray.direction,
          track.matrixWorld,
          group.matrixWorld,
          bendFrame.bendRadiusPx,
          bendFrame.pixelSize,
        )
      }
      // Flat mode, or curved mode with no bend group mounted yet (the very
      // first frame) - today's exact, unchanged math.
      return rayToTrackFraction(e.ray.origin, e.ray.direction, track.matrixWorld)
    },
    [bendFrame],
  )

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
      // A plain HOVER move (no active drag) is not a drag-gesture event at
      // all, so it deliberately bypasses `reduceDrag` rather than being fed
      // into it: that reducer's `pointermove` case exists to reject a
      // FOREIGN pointer mid-drag, which does not apply here - there is no
      // gesture in progress to be foreign to. `@pmndrs/pointer-events`
      // reliably emits hover-only pointer callbacks in this stack with no
      // button held - see sphere-shell's own `HoverLabel` (this dock's
      // fifteen button tooltips, all driven by `onPointerEnter`/
      // `onPointerLeave` with no press involved) - so this reuses the SAME
      // `seekPreviewS` seam `SubtitleHud.tsx` already reads from a drag,
      // extending it to a plain hover exactly as that component's own doc
      // comment now describes. Not propagation-stopped: an idle hover over
      // the track is not a gesture that needs to suppress anything else.
      if (!dragStateRef.current.dragging) {
        const fraction = resolveFraction(e)
        if (fraction !== null) {
          store.getState().setSeekPreview(fractionToSeconds(fraction, durationS))
        }
        return
      }
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
    [resolveFraction, applyEffects, store, durationS],
  )

  // Clears the hover-only preview once the pointer leaves the track -
  // ONLY while nothing is actually being dragged: a captured drag (see
  // `applyEffects`'s `capture` case) keeps receiving move/up events on this
  // same element even once the pointer ray has physically left its bounds
  // (that is the entire point of `setPointerCapture`, and exactly what
  // `rayToTrackFraction`'s own doc comment relies on for an overshooting
  // drag to still clamp to 0/duration rather than getting stuck) - a real
  // `pointerleave` should not fire mid-capture in that case, but the guard
  // is defensive: an in-progress drag's preview must only ever be cleared by
  // `reduceDrag`'s own `pointerup`/`pointercancel` effects, never by this.
  const onTrackPointerLeave = useCallback(() => {
    if (!dragStateRef.current.dragging) {
      store.getState().setSeekPreview(null)
    }
  }, [store])

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
  const transcriptWindow = useWindowState(PANEL_WINDOW_IDS.transcript)

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
  const transcriptOpen =
    transcriptWindow != null && !transcriptWindow.closed && !transcriptWindow.minimized
  // Whether there is a Transkript window to toggle AT ALL - the same predicate
  // `TranscriptWindow` gates its own existence on, so the button cannot outlive
  // its window. See `panelWindowAvailable`.
  const transcriptAvailable = panelWindowAvailable(PANEL_WINDOW_IDS.transcript, {
    segmentCount: episode.segments?.length ?? 0,
    cueCount: cuesCount,
    hasSeries: episode.seriesId != null,
  })

  const captionsActive = subtitlesOn && !subtitlesDisabled

  // Which controls the tour's CURRENT step is pointing at - `[]` whenever no
  // tour is running, or the running step highlights nothing (the controller
  // bindings step, and the shell-owned menu/exit step - see `tourSteps.ts`).
  const highlightIds = tour?.step.highlightIds
  const isHighlighted = (id: TourControlId): boolean => highlightIds?.includes(id) ?? false

  return (
    <Container flexDirection="row" alignItems="center" gap={8} width={SLOT_WIDTH_PX}>
      {/* Play/Pause, spanning both rows. Square and 60 px on a side - by far
          the largest target in the strip, because it is the one control a
          viewer reaches for without looking at the dock. */}
      <HoverLabel
        label={playing ? LABEL.pause : LABEL.play}
        controlHeight={PLAY_BUTTON_PX}
      >
        <Container
          height={PLAY_BUTTON_PX}
          width={PLAY_BUTTON_PX}
          alignItems="center"
          justifyContent="center"
          backgroundColor="#2f6f4f"
          borderRadius={8}
          // The tour's highlight is a ring, not a background swap, here -
          // unlike `IconButton`'s `highlighted`, this button's green already
          // carries its own meaning ("this is the one to press"), so
          // replacing it would fight that instead of adding to it.
          borderWidth={isHighlighted(TOUR_CONTROL_IDS.playPause) ? 3 : 0}
          borderColor={isHighlighted(TOUR_CONTROL_IDS.playPause) ? TOUR_HIGHLIGHT_BORDER : '#2f6f4f'}
          hover={{ backgroundColor: '#3f9f6f' }}
          onPointerDown={playPress.onPointerDown}
          onPointerUp={playPress.onPointerUp}
          onPointerCancel={playPress.onPointerCancel}
        >
          {/* Hit-transparent like every other icon in the strip (see
              `IconButton`'s doc comment). This button is the biggest target in
              the app and still needs it: a 26 px icon inside a 60 px square is
              most of what the ray actually lands on, and press-on-glyph +
              release-on-panel is not a click. */}
          <PlayPauseIcon
            width={26} height={26} color="#ffffff"
            pointerEvents={DECORATIVE_POINTER_EVENTS}
          />
        </Container>
      </HoverLabel>

      {/* Takes everything the Play/Pause button does not, and no `alignItems`
          override: a flex column stretches its children by default, so both
          rows are as wide as this column - which is what puts the timeline
          across the whole dock rather than across row 2's content. See the doc
          comment. */}
      <Container flexDirection="column" gap={ROW_GAP_PX} flexGrow={1}>
        {/* ROW 1: the timeline, and nothing else. The time readouts stay where
            they have always been - flanking the track - at the user's explicit
            request („Die Abspielposition und Dauer koennen da bleiben wo sie
            gerade sind"). */}
        <Container
          height={ROW_HEIGHT_PX}
          flexDirection="row"
          alignItems="center"
          gap={8}
          borderRadius={6}
          // The timeline highlight lives on this wrapping row, not the 6px
          // track alone (`TRACK_HEIGHT_PX`) - a thin bar's own border would
          // be easy to miss at a glance; the whole row, time readouts
          // included, is what actually reads as "look here".
          borderWidth={isHighlighted(TOUR_CONTROL_IDS.timeline) ? 2 : 0}
          // Always a real, parseable colour - see `IconButton`'s doc comment
          // on never toggling a uikit prop to/from something invalid; with
          // `borderWidth={0}` this never actually renders when not
          // highlighted.
          borderColor={TOUR_HIGHLIGHT_BORDER}
        >
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
            // A thin track needs a bigger visual cue than a border alone -
            // the whole row it sits in (time labels included) is what
            // actually catches the eye, so the highlight is drawn on the
            // wrapping row below, not just on the track itself.
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerCancel}
            onPointerLeave={onTrackPointerLeave}
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
            {/* Chapter tick marks - one per INTERIOR segment boundary (see
                `segmentTickFractions`). Rendered AFTER the fill bar above, so
                they draw on top of it and stay visible whether a given tick
                falls in the played or unplayed portion of the track - see
                `TICK_COLOR`'s doc comment for why a translucent white reads on
                both. `DECORATIVE_POINTER_EVENTS` on every one of them is
                load-bearing, not incidental: the track must stay ONE hit
                object (see this component's own doc comment on the drag
                math), and a tick sitting in front of the fill bar would
                otherwise be exactly the kind of extra Object3D that could
                intercept a press meant for the track underneath it. */}
            {tickFractions.map((fraction, i) => (
              <Container
                key={i}
                positionType="absolute"
                positionLeft={`${Math.round(fraction * 1000) / 10}%`}
                positionTop={0}
                width={TICK_WIDTH_PX}
                height={TRACK_HEIGHT_PX}
                backgroundColor={TICK_COLOR}
                opacity={TICK_OPACITY}
                pointerEvents={DECORATIVE_POINTER_EVENTS}
              />
            ))}
          </Container>
          <Text fontSize={11} color="#cfd8ff" width={TIME_LABEL_WIDTH_PX}>
            {totalLabel}
          </Text>
        </Container>

        {/* ROW 2: where you are, the neighbouring recordings, and every
            remaining control. */}
        <Container flexDirection="row" alignItems="center" gap={4}>
          {/* Wraps just the breadcrumb crumbs - the prev/next `IconButton`s
              beside it (below) carry their own `highlighted` prop instead,
              since they are not part of this trail. */}
          <Container
            flexDirection="row"
            alignItems="center"
            gap={4}
            borderRadius={6}
            borderWidth={isHighlighted(TOUR_CONTROL_IDS.breadcrumb) ? 2 : 0}
            borderColor={TOUR_HIGHLIGHT_BORDER}
          >
          {trail.map((crumb, index) => {
            // The last crumb is no longer inert: it opens (and closes) the
            // Reihe window, and says so with a list icon. Only when there IS a
            // series - for a single recording it stays a plain label.
            const opensSeries = crumb.kind === 'current' && showNeighbours
            const interactive = crumb.kind !== 'current' || opensSeries
            return (
              // `kind` is unique within a trail (one home, at most one series,
              // one current - see breadcrumbTrail), so it is a stable key.
              <CrumbRow
                key={crumb.kind}
                crumb={crumb}
                showChevron={index > 0}
                interactive={interactive}
                opensSeries={opensSeries}
                onPress={() => onCrumb(crumb)}
              />
            )
          })}
          </Container>

          {showNeighbours && (
            <Container flexDirection="row" alignItems="center" gap={4} marginLeft={4}>
              <IconButton
                size={CRUMB_ROW_HEIGHT_PX}
                disabled={neighbours.previous == null}
                highlighted={isHighlighted(TOUR_CONTROL_IDS.previousEpisode)}
                label={LABEL.previousEpisode}
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
                highlighted={isHighlighted(TOUR_CONTROL_IDS.nextEpisode)}
                label={LABEL.nextEpisode}
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
            highlighted={isHighlighted(TOUR_CONTROL_IDS.captionsToggle)}
            // Names the state the press moves TO, like the shell's own
            // Curved/Flat button - see LABEL.
            label={captionsActive ? LABEL.captionsOff : LABEL.captionsOn}
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
                highlighted={isHighlighted(TOUR_CONTROL_IDS.captionSmaller)}
                label={LABEL.captionSmaller}
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
                highlighted={isHighlighted(TOUR_CONTROL_IDS.captionLarger)}
                label={LABEL.captionLarger}
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
                highlighted={isHighlighted(TOUR_CONTROL_IDS.captionUp)}
                label={LABEL.captionUp}
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
                highlighted={isHighlighted(TOUR_CONTROL_IDS.captionDown)}
                label={LABEL.captionDown}
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
            highlighted={isHighlighted(TOUR_CONTROL_IDS.mute)}
            label={muted ? LABEL.unmute : LABEL.mute}
            labelAlign="right"
            onPress={toggleMuted}
          >
            <VolumeIcon width={SMALL_ICON_PX} height={SMALL_ICON_PX} color="#ffffff" />
          </IconButton>
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            disabled={volume <= 0}
            highlighted={isHighlighted(TOUR_CONTROL_IDS.volumeDown)}
            label={LABEL.volumeDown}
            labelAlign="right"
            onPress={() => applyVolumeStep(-1)}
          >
            <Minus width={SMALL_ICON_PX} height={SMALL_ICON_PX} color={volume <= 0 ? DISABLED_COLOR : '#ffffff'} />
          </IconButton>
          <Text fontSize={11} color={muted ? DISABLED_COLOR : '#cfd8ff'} width={30} textAlign="center">
            {`${volumeToPercent(volume)}%`}
          </Text>
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            disabled={volume >= 1}
            highlighted={isHighlighted(TOUR_CONTROL_IDS.volumeUp)}
            label={LABEL.volumeUp}
            labelAlign="right"
            onPress={() => applyVolumeStep(1)}
          >
            <Plus width={SMALL_ICON_PX} height={SMALL_ICON_PX} color={volume >= 1 ? DISABLED_COLOR : '#ffffff'} />
          </IconButton>

          {/* The window toggles, together at the end of the row: „Für das
              Transcription Fenster bitte auch noch einen Button ins Dock, statt
              des Fenster Platzhalters" and, from the round before,
              „Einen i/Info-Button im Dock zum Anzeigen der Infos."
              Both windows now pass `dockTile={false}`, so these buttons are
              their way back and their dock tile is gone; both are lit like an
              active toggle while their window is on screen, which is what makes
              the second press predictable.

              Transkript takes `ScrollText` - a scroll of running text, which is
              what a transcript is, and legible at 13 px against its neighbours
              in a way `FileText` (a document, i.e. "a file") is not. It sits
              before Info because it is the one a viewer opens WHILE watching. */}
          {/* Greyed and inert for a recording with no captions, exactly like the
              CC button beside it. `TranscriptWindow` never registers a window
              without cues (`panelWindowAvailable`), so a live-looking button
              here would be a permanent silent no-op - worse than no button,
              because before it existed an uncaptioned recording made no promise
              at all. Found by code review; the gate now comes from the same
              predicate the window itself gates on. */}
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            background={transcriptOpen ? ACTIVE_BG : BUTTON_BG}
            hoverBackground={transcriptOpen ? ACTIVE_BG_HOVER : BUTTON_BG_HOVER}
            disabled={!transcriptAvailable}
            highlighted={isHighlighted(TOUR_CONTROL_IDS.transcript)}
            label={LABEL.transcript}
            labelAlign="right"
            onPress={() => togglePanel(PANEL_WINDOW_IDS.transcript, transcriptWindow)}
          >
            <ScrollText
              width={SMALL_ICON_PX}
              height={SMALL_ICON_PX}
              color={transcriptAvailable ? '#ffffff' : DISABLED_COLOR}
            />
          </IconButton>
          <IconButton
            size={CRUMB_ROW_HEIGHT_PX}
            background={infoOpen ? ACTIVE_BG : BUTTON_BG}
            hoverBackground={infoOpen ? ACTIVE_BG_HOVER : BUTTON_BG_HOVER}
            highlighted={isHighlighted(TOUR_CONTROL_IDS.info)}
            label={LABEL.info}
            labelAlign="right"
            onPress={() => togglePanel(PANEL_WINDOW_IDS.info, infoWindow)}
          >
            <Info width={SMALL_ICON_PX} height={SMALL_ICON_PX} color="#ffffff" />
          </IconButton>
        </Container>
      </Container>

      {/* The tutorial tour's bubble - a sibling of the two rows above, NOT a
          `<HeadLocked>` (unlike `SubtitleHud.tsx`'s captions): it has to sit
          ABOVE THE DOCK specifically, following the dock's own curved bend
          when sphere-shell renders it that way, which only holds while it is
          part of THIS component's own tree - see `TourBubble.tsx`'s doc
          comment. Positioned absolutely relative to this component's own
          outermost container (the same technique the fill bar/tick marks
          above use relative to the track), with `positionBottom` set so its
          own bottom edge (the speech-bubble tail) lands `TOUR_GAP_PX` above
          this container's top edge - see the worked derivation in this
          file's comment history for `positionBottom`'s exact value. Renders
          nothing, and therefore cannot block a click reaching the dock
          underneath, whenever no tour is running (`tour?.step` is
          `undefined` - the ordinary case).

          `positionLeft` is computed, not `positionLeft={0}/positionRight={0}`
          plus `alignItems="center"` (the previous approach): that centered
          the bubble over THIS component's own `SLOT_WIDTH_PX` slot, which is
          narrower than the REAL rendered dock by `SHELL_EXTRA_BASE_PX` (and,
          in an active XR session, `SHELL_EXTRA_XR_PX` more) - see those
          constants' own doc comment. „Das Tutorial bitte Mittig dann über
          dem Dock" means centered over the dock the viewer actually SEES,
          not just this app's own slot within it, so the offset is folded in
          here: the dock's total width, halved, minus half the bubble's own
          (known, exported) width. */}
      {tour && (
        <Container
          positionType="absolute"
          positionLeft={
            (SLOT_WIDTH_PX + SHELL_EXTRA_BASE_PX + (xrSession.active ? SHELL_EXTRA_XR_PX : 0)) / 2 -
            TOUR_PANEL_WIDTH_PX / 2
          }
          positionBottom={PLAY_BUTTON_PX + TOUR_GAP_PX}
        >
          <TourBubble
            step={tour.step}
            stepNumber={tour.stepNumber}
            stepCount={tour.stepCount}
            isLast={tour.isLast}
            onAdvance={tour.onAdvance}
            onSkip={tour.onSkip}
          />
        </Container>
      )}
    </Container>
  )
}
