import type { ComponentType, ReactNode } from 'react'
import { Container, Text, type SvgProperties } from '@react-three/uikit'
import { Joystick, MousePointerClick } from '@react-three/uikit-lucide'
import { DECORATIVE_POINTER_EVENTS } from 'sphere-shell'
import { badgeHand, type TourBadgeId, type TourIconId, type TourStep, type TourStepLine } from './tourSteps'
import { useCapturedPress } from './useCapturedPress'

/**
 * The tutorial tour's speech-bubble panel - one explanation, plus "Weiter"/
 * "Fertig" and "Tutorial beenden", rendered ABOVE the dock (see
 * `DockTransport.tsx`'s own doc comment for exactly where this is anchored
 * and why - it is a child of that component's own control-strip container,
 * positioned absolutely relative to it, so it bends with the dock under
 * sphere-shell's curved mode instead of floating independently of it).
 *
 * ## Why this is not a modal, and does not dim the scene
 *
 * „Waehrend der Tour offen ist darf sie die Bedienung nicht blockieren" - the
 * dock underneath stays fully clickable (this panel occupies its own screen
 * region above the control strip, not a full-view overlay), and there is no
 * darkening backdrop. A visitor who already knows what a button does, or who
 * simply wants to try the video before finishing the walk-through, is never
 * forced to sit through it.
 *
 * ## Why a diamond, not an SVG arrow
 *
 * uikit's shape vocabulary is boxes (`Container`) and glyphs (`Text`/lucide
 * icons), not arbitrary paths - there is no cheap way to draw a real
 * speech-bubble tail. A small square rotated 45 degrees
 * (`transformRotateZ`), tucked half-behind the panel's own bottom edge,
 * reads as a pointer toward whatever is highlighted in the dock below
 * without needing a new shape primitive.
 */

const TOUR_BG = '#1a1a24'
const TOUR_BORDER = '#5a4a1f'
const TOUR_ACCENT_BG = '#2f6f4f'
const TOUR_ACCENT_BG_HOVER = '#3f9f6f'
const TOUR_GHOST_BG = '#2c2c3a'
const TOUR_GHOST_BG_HOVER = '#3a3a4a'

/** The panel's own design width - see `TourBubble`'s doc comment for why this needs to be a real, named constant rather than shrink-wrapped: a `<Text>` only wraps when something hands its measure function a width (`docs/UIKIT-NOTES.md` entry 7). */
export const TOUR_PANEL_WIDTH_PX = 460
const TOUR_PANEL_PADDING_PX = 18
const TOUR_TEXT_MAX_WIDTH_PX = TOUR_PANEL_WIDTH_PX - TOUR_PANEL_PADDING_PX * 2

/** Big, easy VR targets, per the brief - well above the smallest dock buttons, since this bubble asks to be pressed once per step rather than aimed at repeatedly. */
const TOUR_BUTTON_HEIGHT_PX = 44

function TourButton({
  label,
  onPress,
  variant,
}: {
  label: string
  onPress: () => void
  variant: 'primary' | 'ghost'
}) {
  const resting = variant === 'primary' ? TOUR_ACCENT_BG : TOUR_GHOST_BG
  const hovered = variant === 'primary' ? TOUR_ACCENT_BG_HOVER : TOUR_GHOST_BG_HOVER
  // Pointer-captured press, not `onClick` - see `pressCapture.ts`'s doc
  // comment for why a drifting Quest ray needs this (the same jitter fix
  // applied to `DockTransport.tsx`'s `IconButton`).
  const press = useCapturedPress(onPress)
  return (
    <Container
      height={TOUR_BUTTON_HEIGHT_PX}
      paddingX={18}
      alignItems="center"
      justifyContent="center"
      backgroundColor={resting}
      borderRadius={8}
      // Always a plain object, never conditionally `undefined` - see
      // `docs/UIKIT-NOTES.md` entry 1.
      hover={{ backgroundColor: hovered }}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
    >
      {/* Hit-transparent, like every other button label in this app - see
          `DockTransport.tsx`'s `IconButton` doc comment (entry 6b in the
          uikit notes: a press-on-glyph, release-on-panel pair is not a
          click). */}
      <Text fontSize={14} color="#ffffff" pointerEvents={DECORATIVE_POINTER_EVENTS}>
        {label}
      </Text>
    </Container>
  )
}

/** A physical badge's own leading glyph size and the row's shared spacing - see `TourBadge`'s doc comment. */
const BADGE_SIZE_PX = 28
const BADGE_ICON_PX = 18
const BADGE_ROW_GAP_PX = 8

/**
 * Colour-hint per Quest reality („Color-hint per Quest reality: A/B on the
 * right controller, X/Y on the left"): the right controller's badges (A/B)
 * get one tint, the left's (X/Y - `badgeHand`, `tourSteps.ts`) another, so a
 * badge's own colour agrees with which hand actually holds that button - on
 * top of the clarifying text line `tourSteps.ts`'s `TOUR_STEPS` already
 * carries. Deliberately far from `TOUR_HIGHLIGHT_BG`/`_BORDER` (the dock's
 * "look here" amber) so a badge can never read as that unrelated highlight.
 */
const BADGE_COLOR = {
  rechts: { background: '#2f6f9f', border: '#7fb3e0' },
  links: { background: '#9f6f3f', border: '#e0b37f' },
} as const

/**
 * A physical button badge: a circular `Container` (`borderRadius` half its
 * own height, per the user's „A, B, X, Y in einen Kreis setzen") holding the
 * letter, tinted per `badgeHand`. The border is a lighter tone of the same
 * hue rather than the flat single-tone fill every other control in this app
 * uses - a small rim-highlight is the closest a uikit `Container` (one flat
 * `borderColor`, no per-side colours - see `docs/UIKIT-NOTES.md` for the
 * project's running list of what this uikit version can/can't do) gets to
 * the "etwas physischere Darstellung" (a real button's bevelled cap) the
 * user asked for.
 */
function TourBadge({ id }: { id: TourBadgeId }) {
  const { background, border } = BADGE_COLOR[badgeHand(id)]
  return (
    <Container
      width={BADGE_SIZE_PX}
      height={BADGE_SIZE_PX}
      borderRadius={BADGE_SIZE_PX / 2}
      alignItems="center"
      justifyContent="center"
      backgroundColor={background}
      borderWidth={2}
      borderColor={border}
    >
      <Text fontSize={13} fontWeight="bold" color="#ffffff" pointerEvents={DECORATIVE_POINTER_EVENTS}>
        {id}
      </Text>
    </Container>
  )
}

/**
 * Symbolic icon id -> actual uikit-lucide glyph. `tourSteps.ts` only ever
 * hands this component a `TourIconId` string (`'trigger' | 'stick'`), never
 * a component reference - see that module's own doc comment on why (staying
 * render-agnostic). `Joystick` reads as an analog stick at a glance
 * (`@react-three/uikit-lucide`'s own icon set - checked against what it
 * actually exports, not guessed); `MousePointerClick` reads as "point and
 * press", which is exactly what the trigger does.
 */
const TOUR_ICON: Record<TourIconId, ComponentType<SvgProperties>> = {
  trigger: MousePointerClick,
  stick: Joystick,
}

/**
 * One line of a step's body. A plain `string` renders exactly as before (an
 * optional leading "- " for a bulleted step). A structured `TourBindingRow`
 * (only the `controller` step's lines are ever one of these - see
 * `tourSteps.ts`) instead leads with its badges and/or icon, and skips the
 * leading dash: the badge/icon itself is the "look here" marker, and adding
 * both would be redundant clutter in an already-compact row. The row's own
 * `<Text>` gets a narrower `maxWidth` than a plain line - it has to leave
 * room for whatever badges/icon precede it in the same flex row, or it could
 * wrap wider than the panel actually has left (`docs/UIKIT-NOTES.md` entry
 * 7: a `<Text>`'s wrap bound is its OWN `maxWidth`, not whatever space its
 * siblings happen to leave it).
 */
function TourLine({ line, bullet }: { line: TourStepLine; bullet: boolean }): ReactNode {
  if (typeof line === 'string') {
    return (
      <Text fontSize={14} lineHeight={1.4} color="#e8e8ee" maxWidth={TOUR_TEXT_MAX_WIDTH_PX}>
        {bullet ? `- ${line}` : line}
      </Text>
    )
  }
  const Icon = line.icon ? TOUR_ICON[line.icon] : null
  const badgeCount = line.badges?.length ?? 0
  const prefixWidth =
    badgeCount * (BADGE_SIZE_PX + BADGE_ROW_GAP_PX) + (Icon ? BADGE_ICON_PX + BADGE_ROW_GAP_PX : 0)
  return (
    <Container flexDirection="row" alignItems="center" gap={BADGE_ROW_GAP_PX}>
      {line.badges?.map((id) => <TourBadge key={id} id={id} />)}
      {Icon && <Icon width={BADGE_ICON_PX} height={BADGE_ICON_PX} color="#e8e8ee" />}
      <Text fontSize={14} lineHeight={1.4} color="#e8e8ee" maxWidth={TOUR_TEXT_MAX_WIDTH_PX - prefixWidth}>
        {line.text}
      </Text>
    </Container>
  )
}

export function TourBubble({
  step,
  stepNumber,
  stepCount,
  isLast,
  onAdvance,
  onSkip,
}: {
  step: TourStep
  /** 1-based, for the "Schritt x von y" orientation line - not shown to the viewer as an id. */
  stepNumber: number
  stepCount: number
  isLast: boolean
  onAdvance: () => void
  onSkip: () => void
}) {
  return (
    <Container flexDirection="column" alignItems="center">
      <Container
        width={TOUR_PANEL_WIDTH_PX}
        flexDirection="column"
        gap={10}
        padding={TOUR_PANEL_PADDING_PX}
        borderRadius={14}
        backgroundColor={TOUR_BG}
        borderWidth={2}
        borderColor={TOUR_BORDER}
      >
        <Text fontSize={11} color="#9a9aa5">
          {`Schritt ${stepNumber} von ${stepCount}`}
        </Text>
        <Container flexDirection="column" gap={6}>
          {step.lines.map((line, i) => (
            <TourLine key={i} line={line} bullet={step.bullet === true} />
          ))}
        </Container>
        <Container flexDirection="row" justifyContent="flex-end" gap={8} marginTop={4}>
          <TourButton label="Tutorial beenden" onPress={onSkip} variant="ghost" />
          <TourButton label={isLast ? 'Fertig' : 'Weiter'} onPress={onAdvance} variant="primary" />
        </Container>
      </Container>
      {/* The speech-bubble tail - see the doc comment above. Decorative only. */}
      <Container
        width={16}
        height={16}
        marginTop={-8}
        backgroundColor={TOUR_BG}
        borderWidth={2}
        borderColor={TOUR_BORDER}
        transformRotateZ={45}
        pointerEvents="none"
      />
    </Container>
  )
}
