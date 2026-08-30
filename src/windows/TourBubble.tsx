import type { ReactNode } from 'react'
import { Container, Text } from '@react-three/uikit'
import { DECORATIVE_POINTER_EVENTS } from 'sphere-shell'
import type { TourStep } from './tourSteps'

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
      onClick={(e) => {
        e.stopPropagation()
        onPress()
      }}
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

function TourLine({ text, bullet }: { text: string; bullet: boolean }): ReactNode {
  return (
    <Text fontSize={14} lineHeight={1.4} color="#e8e8ee" maxWidth={TOUR_TEXT_MAX_WIDTH_PX}>
      {bullet ? `- ${text}` : text}
    </Text>
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
            <TourLine key={i} text={line} bullet={step.bullet === true} />
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
