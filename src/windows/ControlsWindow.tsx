import { useState } from 'react'
import { useStore } from 'zustand'
import { Container, Text } from '@react-three/uikit'
import { Captions, Minus, Plus } from '@react-three/uikit-lucide'
import { Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { stepVolume, volumeToPercent } from './transportState'

const BUTTON_ICON_PX = 14
const DISABLED_COLOR = '#6a6a75'
const SUBTITLE_BG = '#2c2c3a'
const SUBTITLE_BG_HOVER = '#3a3a4a'
// Umlauts are fine here - Task 11's live verification against the real
// server confirmed uikit's default font renders accented Latin letters
// (LibraryWindow.tsx's own "< Zurück" ships with one); the tofu-glyph defect
// documented there was specifically about typographic PUNCTUATION ("‹",
// "·", "…"), not diacritics.
const HINT_TEXT = 'Keine Untertitel für diese Aufzeichnung verfügbar.'

/**
 * Small player-mode-only window: volume (-/value/+, in steps of 0.1),
 * subtitle toggle, and the open episode's metadata (title, creators,
 * series). Rendered next to `VideoWindows` (see `App.tsx`) - only while
 * `mode === 'player'`, mirroring `DockTransport`'s own gate.
 *
 * `volume` is local `useState`, not a store field: `SyncEngine.setVolume`
 * has no reactive counterpart in `PlayerStore` (see `DockTransport.tsx`'s
 * doc comment on the same issue for play/pause intent) - but unlike intent,
 * the engine's `volume` getter never gets forced back to a fixed value by
 * anything else in this app (no `openEpisode`/`toBrowse` equivalent resets
 * it), so seeding from `engine.volume` on mount is sufficient by itself; no
 * effect is needed to re-sync it on an episode change.
 *
 * The pure volume-stepping/percent-display math lives in `transportState.ts`
 * alongside the dock's own pure logic - this file stays thin glue.
 *
 * ## A real, reproduced uikit 1.0.74 defect: never pass `hover={undefined}`
 *
 * The subtitle toggle's disabled state was originally written the obvious
 * way - `hover={subtitlesDisabled ? undefined : { backgroundColor: ... }}`,
 * meaning "no hover highlight while disabled". Live verification (opening
 * an episode straight from the library, which unmounts `LibraryWindow` and
 * mounts `VideoWindows` + this component in the SAME commit) crashed the
 * whole scene almost every time, a few hundred ms after the switch:
 * `Uncaught TypeError: Cannot convert undefined or null to object` inside
 * `@react-three/fiber`'s reconciler `removeChild`, four frames deep.
 *
 * Bisected by elimination (stub -> add volume row -> add metadata -> add
 * subtitle block; each variant run against a FRESH `vite` dev server and a
 * hard page reload, several trials each, to rule out HMR/timing noise) to
 * this exact prop: reverting only the `hover` value from a
 * conditional-`undefined` ternary to an always-present object - keeping
 * every conditional CHILD (`{subtitlesDisabled && <Text>...}`,
 * `{episode.creators.length > 0 && ...}`) exactly as originally written -
 * made the crash disappear across every subsequent trial. So it is
 * specifically `hover` toggling between an object and `undefined` (not
 * conditional children, not the ternary ITSELF, not this file's other
 * conditionals) that corrupts something in uikit's own reconciliation badly
 * enough to blow up an unrelated tree replacement shortly after.
 *
 * The fix keeps `hover` a plain object on every render and encodes "no
 * visible hover while disabled" by making its `backgroundColor` match the
 * container's own resting color instead - same disabled behaviour (a
 * disabled toggle no longer visibly lights up on hover), zero risk from the
 * prop that reproduced the crash.
 */
export function ControlsWindow({ store }: { store: PlayerStoreApi }) {
  const episode = useStore(store, (s) => s.episode)
  const subtitlesOn = useStore(store, (s) => s.subtitlesOn)
  const cuesCount = useStore(store, (s) => s.cues.length)

  const [volume, setVolume] = useState(() => store.getState().engine.volume)

  const applyVolumeStep = (deltaSteps: number) => {
    const next = stepVolume(volume, deltaSteps)
    store.getState().engine.setVolume(next)
    setVolume(next)
  }

  // Defensive only: App.tsx mounts this exclusively in player mode, which
  // always has an episode by the time `mode` flips (store.ts's `openEpisode`
  // sets both in the same `set()` call).
  if (!episode) return null

  const subtitlesDisabled = cuesCount === 0
  const subtitleLabel = `Untertitel: ${subtitlesOn ? 'An' : 'Aus'}`
  const subtitleColor = subtitlesDisabled ? DISABLED_COLOR : '#ffffff'

  return (
    <Window
      id="controls"
      title="Steuerung"
      size={{ width: 26, height: 22 }}
      position={{ azimuth: 0, elevation: 22 }}
    >
      <Container flexDirection="column" gap={12} padding={12} flexGrow={1}>
        <Container flexDirection="row" alignItems="center" gap={8}>
          <Container
            width={26}
            height={26}
            alignItems="center"
            justifyContent="center"
            backgroundColor="#2c2c3a"
            borderRadius={4}
            hover={{ backgroundColor: '#3a3a4a' }}
            onClick={(e) => {
              e.stopPropagation()
              applyVolumeStep(-1)
            }}
          >
            <Minus width={BUTTON_ICON_PX} height={BUTTON_ICON_PX} color="#ffffff" />
          </Container>
          <Text fontSize={13} color="#ffffff">{`${volumeToPercent(volume)}%`}</Text>
          <Container
            width={26}
            height={26}
            alignItems="center"
            justifyContent="center"
            backgroundColor="#2c2c3a"
            borderRadius={4}
            hover={{ backgroundColor: '#3a3a4a' }}
            onClick={(e) => {
              e.stopPropagation()
              applyVolumeStep(1)
            }}
          >
            <Plus width={BUTTON_ICON_PX} height={BUTTON_ICON_PX} color="#ffffff" />
          </Container>
        </Container>

        <Container flexDirection="column" gap={4}>
          <Container
            flexDirection="row"
            alignItems="center"
            gap={8}
            padding={8}
            borderRadius={6}
            backgroundColor={SUBTITLE_BG}
            // Always a plain object - see this file's doc comment above for
            // why `subtitlesDisabled ? undefined : {...}` is NOT safe here.
            hover={{ backgroundColor: subtitlesDisabled ? SUBTITLE_BG : SUBTITLE_BG_HOVER }}
            onClick={(e) => {
              e.stopPropagation()
              if (subtitlesDisabled) return
              store.getState().setSubtitles(!subtitlesOn)
            }}
          >
            <Captions width={BUTTON_ICON_PX} height={BUTTON_ICON_PX} color={subtitleColor} />
            <Text fontSize={13} color={subtitleColor}>{subtitleLabel}</Text>
          </Container>
          {subtitlesDisabled && <Text fontSize={11} color="#8a8a95">{HINT_TEXT}</Text>}
        </Container>

        <Container flexDirection="column" gap={2}>
          <Text fontSize={14} color="#ffffff">{episode.title}</Text>
          {episode.creators.length > 0 && (
            <Text fontSize={12} color="#9a9aa5">{episode.creators.join(', ')}</Text>
          )}
          {episode.seriesTitle != null && <Text fontSize={12} color="#9a9aa5">{episode.seriesTitle}</Text>}
        </Container>
      </Container>
    </Window>
  )
}
