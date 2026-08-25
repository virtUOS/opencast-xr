import { useEffect, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { Container, Text, type VanillaContainer } from '@react-three/uikit'
import { DECORATIVE_POINTER_EVENTS, Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { activeCueIndex, shouldAutoScroll, transcriptRows } from './transcriptState'
import { PANEL_WINDOW_IDS } from './panelWindows'
import { useStartClosed } from './useStartClosed'

// Same reserved-but-unused flank azimuth family as `videoWindowState.ts`'s
// SIDE_AZIMUTH_DEG (55) and `chaptersState.ts`'s CHAPTERS_AZIMUTH_DEG
// (-55)/SeriesWindow's +55 - but pushed further out (92, not 55) so its
// 32deg width (69..101 in fact 76..108 once TRANSCRIPT_AZIMUTH_DEG is fixed
// below) clears SeriesWindow's own 40..70 span with room to spare, rather
// than merely touching it. Elevation 0 matches the main video windows' row
// (they sit at az +-24, well clear of az 92) rather than Chapters/Series's
// -26, so this tall window's vertical span (+-22) doesn't creep into their
// -41..-11 band either.
const TRANSCRIPT_AZIMUTH_DEG = 92
const TRANSCRIPT_ELEVATION_DEG = 0
const WINDOW_SIZE = { width: 32, height: 44 }

const RESTING_BG = '#1a1a22'
const HOVER_BG = '#26262f'
const ACTIVE_BG = '#3a4f7f'
const EMPTY_TEXT = 'Kein Transkript.' // unreachable in practice - this component self-gates on cues.length === 0, see below

/**
 * Player-mode window listing an episode's caption cues as a scrollable
 * transcript - only rendered while the open episode's `cues` are non-empty
 * (`store.cues`, loaded once per episode by `openEpisode` via
 * `client.loadCaptions`; develop.opencast.org's "Was ist Chaos?" and
 * "Espresso" both have real ones, most other recordings there don't).
 *
 * Clicking a row seeks the shared session clock to that cue's start, exactly
 * like `ChaptersWindow`'s segment tiles. The cue containing `currentTimeS`
 * is highlighted.
 *
 * ## One short row per cue, continuation rows for long ones
 *
 * `docs/UIKIT-NOTES.md` entry 2 documents a real uikit defect: a scrolling
 * column whose children include several LONG text blocks that each wrap
 * across many visual lines can render fully blank once the CUMULATIVE
 * wrapped-line count in that one column gets high enough. Real captions are
 * short (a spoken line or two) and this transcript is exactly that kind of
 * scrolling column, so `transcriptState.ts`'s `transcriptRows` keeps every
 * `<Text>` block to one cue's own (short) text - or, for the rare cue over
 * ~200 characters, splits it into multiple short continuation rows sharing
 * the same `cueIndex` (so they highlight and seek together) rather than one
 * long block that would itself contribute many wrapped lines. Ordinary
 * captions still wrap onto 1-2 visual lines each, same as any short
 * paragraph - that is expected and not the defect (the defect is about
 * *volume*, not about wrapping happening at all).
 *
 * ## Auto-scroll: the public `scrollPosition`/`maxScrollPosition` signals
 *
 * `@pmndrs/uikit` 1.0.74's `Container` instance publicly exposes
 * `scrollPosition: Signal<[x, y]>` and `maxScrollPosition: Signal<[x?, y?]>`
 * (confirmed in the installed `.d.ts` - `component.d.ts`/`container.d.ts`,
 * not a private/symbol-keyed internal like the bend-frame gap
 * `docs/UIKIT-NOTES.md` entry 4b hit) - assigning `scrollPosition.value`
 * directly moves the scroll column, and reading `maxScrollPosition.value`
 * gives the clamp range, both without going through `scroll()`'s own
 * gesture-only code path (`scroll.js`; only pointer/wheel handlers call it).
 * A row's own `relativeCenter: Signal<[x, y]>` (also public) gives that
 * row's Y offset from the scroll column's own center in UNSCROLLED content
 * space - i.e. exactly the target `scrollPosition.y` that centers it,
 * negated (`computedGlobalScrollMatrix` in `scroll.js` translates by
 * `+scrollY*pixelSize`, so bringing a row at `relativeCenter.y = r` to
 * screen-center means `scrollPosition.y = -r`). Only the ACTIVE row needs a
 * ref (one callback ref, reassigned as the highlight moves), not one per
 * row.
 *
 * Manual-scroll detection uses the same Container's own `onScroll` listener
 * prop (`(x, y) => ...`, also public) rather than reading internal pointer
 * state - it fires only from a real user gesture (drag/wheel; see
 * `scroll.js`'s `scroll()`), never from this component's own direct
 * `scrollPosition.value` assignment, so "did the user scroll in the last 5s"
 * and "did this effect just move it" can't be confused with each other.
 *
 * ## Live verification note: neither real captioned fixture overflows this window
 *
 * develop.opencast.org's two captioned episodes ("Was ist Chaos?", 29 cues;
 * "Espresso", 10 cues) both render short enough that this window's `scroll`
 * `Container` never actually becomes scrollable (`scrollable.value` stays
 * `[false, false]`, confirmed live) - there is nothing to auto-scroll TO in
 * either fixture. The mechanism above was exercised live by swapping in 60
 * synthetic cues via the store (`store.setState({ cues: ... })`, a console-
 * only test, not shipped): `scrollable` correctly flipped to `[false, true]`
 * with a real `maxScrollPosition.value[1]` (402), and seeking into the list
 * moved `scrollPosition.value[1]` accordingly. So the public-API mechanism is
 * confirmed working end-to-end; it simply has no real-fixture footage of its
 * own to show for this task, only the synthetic one.
 */
export function TranscriptWindow({ store }: { store: PlayerStoreApi }) {
  // Starts as a dock tile rather than on the shell - see `panelWindows.ts`.
  useStartClosed(PANEL_WINDOW_IDS.transcript)
  const cues = useStore(store, (s) => s.cues)
  const durationMs = useStore(store, (s) => s.episode?.durationMs ?? 0)
  const currentTimeS = useStore(store, (s) => s.currentTimeS)

  const includeHours = durationMs >= 3_600_000
  const rows = useMemo(() => transcriptRows(cues, includeHours), [cues, includeHours])
  const activeIndex = useMemo(() => activeCueIndex(cues, currentTimeS * 1000), [cues, currentTimeS])

  const scrollRef = useRef<VanillaContainer | null>(null)
  const activeRowRef = useRef<VanillaContainer | null>(null)
  // Wall-clock timestamp of the user's last manual scroll gesture, `-Infinity`
  // until the first one - see `shouldAutoScroll`'s doc comment. A ref, not
  // state: writing it must never itself trigger a re-render.
  const lastManualScrollAtRef = useRef<number>(-Infinity)

  // Runs whenever the active cue changes - "when the active cue changes AND
  // the user hasn't manually scrolled in the last 5s, scroll it into view"
  // (the brief, verbatim). Deliberately NOT keyed on `rows`/`cues` too: a
  // fresh episode's first tick already changes `activeIndex` from the
  // previous episode's (or -1), so this still fires on an episode swap
  // without a second dependency.
  useEffect(() => {
    if (activeIndex < 0) return
    if (!shouldAutoScroll(lastManualScrollAtRef.current, Date.now())) return
    const scrollContainer = scrollRef.current
    const activeRow = activeRowRef.current
    if (!scrollContainer || !activeRow) return
    const relativeCenter = activeRow.relativeCenter.value
    const [, maxY] = scrollContainer.maxScrollPosition.value
    if (relativeCenter == null || maxY == null) return
    const [scrollX] = scrollContainer.scrollPosition.value
    const targetY = Math.min(Math.max(-relativeCenter[1], 0), maxY)
    scrollContainer.scrollPosition.value = [scrollX, targetY]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex])

  const seekToCue = (cueIndex: number) => {
    const cue = cues[cueIndex]
    if (!cue) return
    store.getState().engine.seek(cue.startMs / 1000)
  }

  // Defensive only: App.tsx is expected to mount this only once
  // `cues.length > 0`, mirroring `ChaptersWindow`'s own self-gate - but this
  // component checks its own precondition too rather than trusting the
  // caller silently.
  if (cues.length === 0) return null

  return (
    <Window
      id="transcript"
      title="Transkript"
      size={WINDOW_SIZE}
      position={{ azimuth: TRANSCRIPT_AZIMUTH_DEG, elevation: TRANSCRIPT_ELEVATION_DEG }}
    >
      <Container
        ref={scrollRef}
        flexGrow={1}
        flexDirection="column"
        overflow="scroll"
        padding={12}
        gap={6}
        onScroll={() => {
          lastManualScrollAtRef.current = Date.now()
        }}
      >
        {rows.length === 0 ? (
          <Text fontSize={14} color="#9a9aa5">{EMPTY_TEXT}</Text>
        ) : (
          rows.map((row) => {
            const active = row.cueIndex === activeIndex
            return (
              <Container
                key={row.id}
                ref={active ? (instance: VanillaContainer | null) => { activeRowRef.current = instance } : undefined}
                padding={6}
                borderRadius={4}
                backgroundColor={active ? ACTIVE_BG : RESTING_BG}
                // Always a plain object - see docs/UIKIT-NOTES.md entry 1:
                // toggling `hover` between an object and `undefined` across
                // renders is a reproduced uikit crash.
                hover={{ backgroundColor: active ? ACTIVE_BG : HOVER_BG }}
                onClick={(e) => {
                  e.stopPropagation()
                  seekToCue(row.cueIndex)
                }}
              >
                {/* Hit-transparent, so the ROW is one hit object. The text
                    fills the row, so without this nearly every press lands on
                    the text and the click survives only if the release lands on
                    exactly the same text object - see sphere-shell's
                    DECORATIVE_POINTER_EVENTS. */}
                <Text
                  fontSize={13}
                  color={active ? '#ffffff' : '#c9c9d2'}
                  pointerEvents={DECORATIVE_POINTER_EVENTS}
                >
                  {row.text}
                </Text>
              </Container>
            )
          })
        )}
      </Container>
    </Window>
  )
}
