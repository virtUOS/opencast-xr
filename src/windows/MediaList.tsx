import { Container, Text, Image } from '@react-three/uikit'
import { DECORATIVE_POINTER_EVENTS } from 'sphere-shell'

export interface MediaListItem {
  id: string
  title: string
  subtitle?: string
  imageUrl?: string
}

export interface MediaListProps {
  items: MediaListItem[]
  onSelect: (id: string) => void
  /** Present iff there's another page worth fetching - the tail button renders only when this is set. */
  onMore?: () => void
  /** Defaults to "Mehr laden" (used unconditionally by every caller so far - no need for callers to repeat it). */
  moreLabel?: string
  /** Shown instead of the tile column when `items` is empty. Required: an empty list with no explanation reads as broken, not empty. */
  emptyText: string
  /**
   * Id of one item to render as the current/active one - a fixed highlighted
   * background instead of the ordinary resting/hover pair. Added for Task 14
   * (ChaptersWindow's "segment containing currentTimeS", SeriesWindow's
   * "current episode") as the minimal generic extension the brief asked for,
   * rather than copying the tile idiom into each window.
   *
   * Purely visual - this component still calls `onSelect` for the active
   * item exactly like any other. A caller that wants the active tile to be
   * non-clickable (SeriesWindow's "current episode ... not clickable") has
   * to decide that itself, in its own `onSelect`, before doing anything with
   * the id: MediaList has no opinion on what "select" means to a caller, and
   * ChaptersWindow's own spec has no such restriction (re-selecting the
   * already-active segment is a valid "restart this chapter" seek).
   *
   * Hover for the active item is a fixed color equal to its own resting
   * color (not omitted) - see `truncate`'s sibling gotcha, `docs/UIKIT-NOTES.md`
   * entry 1: toggling `hover` between an object and `undefined` across
   * renders is a reproduced uikit crash, so "no visible hover change" is
   * encoded by matching values, the same fix `ControlsWindow.tsx`'s disabled
   * subtitle toggle uses.
   */
  activeId?: string
}

const RESTING_BG = '#20202a'
const HOVER_BG = '#2c2c3a'
const ACTIVE_BG = '#3a4f7f'

const TILE_IMAGE_W = 96
const TILE_IMAGE_H = 54

// @react-three/uikit 1.0.74's Text has a MANY-WRAPPED-LINES defect: a Text
// that's forced to wrap across more than a couple of lines renders
// incorrectly (see Dock.tsx/MarkdownContent.tsx's precedent - both keep tile
// text to one short line). There's no width-aware ellipsis in this uikit
// version, so this is a plain character-count truncation done before the
// string ever reaches <Text> - crude, but it guarantees the defect's
// precondition (many wrapped lines) never occurs.
//
// "..." (three ASCII periods), not "…" (U+2026): live verification of this
// same font (against "‹" and "·" - see libraryState.ts's toEpisodeTile doc
// comment) showed characters outside plain ASCII silently rendering as tofu
// boxes, so this component doesn't risk the one uikit's default font
// version installed here doesn't have either.
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

const TITLE_MAX_CHARS = 42
const SUBTITLE_MAX_CHARS = 56

/**
 * Reusable uikit tile list: a scrollable column of Image+two-line-Text tiles
 * with a hover cue, and an optional "Mehr laden" tail button. Used by
 * LibraryWindow at both the series and the episode level; SeriesWindow
 * (Task 14) reuses it directly with no wrapper tile type of its own -
 * ChaptersWindow (also Task 14) goes through it too, feeding it segment
 * tiles built by `chaptersState.ts`. This component still knows nothing
 * about series/episodes/segments/playability, only about tiles (plus, as of
 * Task 14, which one of them is "active" - see `activeId`).
 */
export function MediaList({ items, onSelect, onMore, moreLabel, emptyText, activeId }: MediaListProps) {
  return (
    <Container flexGrow={1} flexDirection="column" overflow="scroll" padding={12} gap={8}>
      {items.length === 0 ? (
        <Text fontSize={14} color="#9a9aa5">{emptyText}</Text>
      ) : (
        items.map((item) => {
          const active = item.id === activeId
          return (
          <Container
            key={item.id}
            flexDirection="row"
            gap={10}
            padding={8}
            alignItems="center"
            backgroundColor={active ? ACTIVE_BG : RESTING_BG}
            borderRadius={6}
            hover={{ backgroundColor: active ? ACTIVE_BG : HOVER_BG }}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(item.id)
            }}
          >
            {/* Every child of a tile opts OUT of hit-testing, so the tile is
                ONE hit object. This matters more here than anywhere else in
                the app: the thumbnail and the text column between them cover
                essentially the whole tile, so nearly every press lands on a
                child rather than on the tile - and @pmndrs/pointer-events only
                emits a `click` when press and release resolve to the exact same
                Object3D, with no movement tolerance at all. Press on the title,
                release on the thumbnail, and the tile stays highlighted (hover
                is emitted on ancestors too) while the click is silently
                discarded. See sphere-shell's DECORATIVE_POINTER_EVENTS for the
                quoted upstream code. `pointerEvents` is inherited in uikit, so
                the value on the column covers both `Text`s under it. */}
            {item.imageUrl ? (
              <Image
                src={item.imageUrl} width={TILE_IMAGE_W} height={TILE_IMAGE_H} borderRadius={4}
                pointerEvents={DECORATIVE_POINTER_EVENTS}
              />
            ) : (
              <Container
                width={TILE_IMAGE_W} height={TILE_IMAGE_H} backgroundColor="#101014" borderRadius={4}
                pointerEvents={DECORATIVE_POINTER_EVENTS}
              />
            )}
            <Container
              flexDirection="column" gap={2} flexGrow={1}
              pointerEvents={DECORATIVE_POINTER_EVENTS}
            >
              <Text fontSize={14} color="#ffffff">{truncate(item.title, TITLE_MAX_CHARS)}</Text>
              {item.subtitle != null && (
                <Text fontSize={11} color="#9a9aa5">{truncate(item.subtitle, SUBTITLE_MAX_CHARS)}</Text>
              )}
            </Container>
          </Container>
          )
        })
      )}
      {onMore != null && (
        <Container
          padding={8}
          borderRadius={6}
          alignItems="center"
          justifyContent="center"
          backgroundColor="#2f4f6f"
          hover={{ backgroundColor: '#3f6f9f' }}
          onClick={(e) => {
            e.stopPropagation()
            onMore()
          }}
        >
          <Text fontSize={13} color="#ffffff" pointerEvents={DECORATIVE_POINTER_EVENTS}>
            {moreLabel ?? 'Mehr laden'}
          </Text>
        </Container>
      )}
    </Container>
  )
}
