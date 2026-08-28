import { useMemo } from 'react'
import { useStore } from 'zustand'
import { Window } from 'sphere-shell'
import type { PlayerStoreApi } from '../player/store'
import { MediaList } from './MediaList'
import { PANEL_WINDOW_IDS } from './panelWindows'
import { useStartClosed } from './useStartClosed'
import { activeSegmentIndex, chapterSeekTargetMs, segmentTiles, type ChapterClickRegion } from './chaptersState'

// Placed at the same azimuth Task 12's video windows reserve for a
// third-or-later stream's flank slot (`SIDE_AZIMUTH_DEG` in
// `videoWindowState.ts`), but at a DIFFERENT elevation (below, rather than
// at 0) - the two main streams live at az +-24/elevation 0, and the flank
// slot itself is only ever populated by a 3rd+ video stream, which no
// exercised episode in this app has (real develop.opencast.org recordings
// carry one flavor; the dev "second stream" toggle tops out at two). So
// under every configuration this task actually verifies, there is no
// collision; a hypothetical many-flavor recording stacking flank rows
// downward could still overlap this window, which is the same class of
// edge case `videoWindowState.ts`'s own doc comment already accepts for
// rows past the third ("no real Opencast recording has eight video
// flavors").
const CHAPTERS_AZIMUTH_DEG = -55
const PANEL_ELEVATION_DEG = -26

const EMPTY_TEXT = 'Keine Kapitel.' // unreachable in practice - App.tsx only mounts this window once segments.length > 0

/**
 * Player-mode window listing an episode's slide segments (OCR chapter
 * markers) - only rendered while the open episode actually has any.
 * develop.opencast.org's own recordings never do; see the dev-only „Kapitel
 * (Test)" toggle in `App.tsx`/`dev/syntheticDualStream.ts` for how this is
 * exercised at all.
 *
 * Clicking a tile seeks the shared session clock (`engine.seek`) to that
 * segment's start. The tile whose range currently contains `currentTimeS`
 * is highlighted via `MediaList`'s `activeId`. All of the
 * truncation/tile-mapping/active-segment math is pure and unit-tested in
 * `chaptersState.ts` - this component is deliberately thin glue over it,
 * the same split `libraryState.ts`/`LibraryWindow.tsx` and
 * `videoWindowState.ts`/`VideoWindows.tsx` already use.
 *
 * ## Split click: image vs. text
 *
 * „Beim anklicken des Bildes zu dem Kapitel kommen, beim anklicken des
 * Textes zu der Stelle wo der Untertitel spielt" - this is the ONE window in
 * the app whose tiles carry both a real preview image (`segment.previewUrl`,
 * via `MediaListItem.imageUrl`) AND text (the OCR `segment.text`) in the
 * same row; `TranscriptWindow` has cues' text but no images at all, so this
 * is where the split lands (see that component's own doc comment for the
 * literal-vs-actual reasoning). `MediaList`'s `onSelectImage` prop turns the
 * image and text into two independent hit targets; both are wired here to
 * `selectSegment`, which resolves the ACTUAL seek target through
 * `chaptersState.ts`'s `chapterSeekTargetMs` - which, for THIS window,
 * resolves both regions to the same time (the segment's own start), because
 * a chapter tile's OCR text belongs to the whole segment rather than to a
 * sub-cue with its own independent timestamp (unlike `TranscriptWindow`'s
 * cues - see that function's own doc comment for the full reasoning). The
 * `region` argument is still threaded through end-to-end rather than
 * collapsed away, so this fact stays documented at its one source rather
 * than assumed silently at every call site.
 */
export function ChaptersWindow({ store }: { store: PlayerStoreApi }) {
  // Starts as a dock tile rather than on the shell - see `panelWindows.ts`.
  // Takes effect only once the recording actually HAS segments, since until
  // then this window registers nothing at all.
  useStartClosed(PANEL_WINDOW_IDS.chapters)
  const segments = useStore(store, (s) => s.episode?.segments)
  const durationMs = useStore(store, (s) => s.episode?.durationMs ?? 0)
  const currentTimeS = useStore(store, (s) => s.currentTimeS)

  const items = useMemo(() => segmentTiles(segments ?? [], durationMs), [segments, durationMs])
  const activeIndex = useMemo(() => activeSegmentIndex(segments ?? [], currentTimeS), [segments, currentTimeS])
  const activeId = activeIndex >= 0 ? String(activeIndex) : undefined

  const selectSegment = (id: string, region: ChapterClickRegion) => {
    const segment = (segments ?? [])[Number(id)]
    if (!segment) return
    store.getState().engine.seek(chapterSeekTargetMs(segment, region) / 1000)
  }

  // Defensive only: App.tsx gates mounting this window on
  // `episode.segments.length > 0` already - see this component's own doc
  // comment.
  if (!segments || segments.length === 0) return null

  return (
    <Window
      id="chapters"
      title="Kapitel"
      size={{ width: 30, height: 30 }}
      position={{ azimuth: CHAPTERS_AZIMUTH_DEG, elevation: PANEL_ELEVATION_DEG }}
    >
      <MediaList
        items={items}
        onSelect={(id) => selectSegment(id, 'text')}
        onSelectImage={(id) => selectSegment(id, 'image')}
        activeId={activeId}
        emptyText={EMPTY_TEXT}
      />
    </Window>
  )
}
