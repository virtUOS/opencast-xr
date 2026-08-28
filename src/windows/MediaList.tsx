import type { ComponentType } from 'react'
import { Container, Text, Image, type SvgProperties } from '@react-three/uikit'
import { DECORATIVE_POINTER_EVENTS } from 'sphere-shell'

export interface MediaListItem {
  id: string
  title: string
  subtitle?: string
  imageUrl?: string
  /**
   * Rendered on a tinted panel instead of the plain placeholder box when
   * `imageUrl` is absent AND the caller wants to say so ON PURPOSE - e.g. a
   * series tile, which never has a thumbnail at all (the Search API's series
   * listing carries only Dublin Core `id`/`title`, no attachments - see
   * `libraryState.ts`'s `seriesTiles`).
   *
   * Left `undefined` (not just falsy) for a tile whose thumbnail SHOULD
   * exist but happens not to - an episode with no preview attachment, say -
   * so that case keeps the old plain grey box rather than being dressed up
   * as a deliberate design choice it isn't. See `tileVisual`.
   */
  placeholderIcon?: ComponentType<SvgProperties>
}

/**
 * Which of the three ways a tile's leading box can render. Pulled out as its
 * own pure function (rather than inlined in the JSX below) so the
 * image/icon/blank decision is unit-testable without rendering uikit, which
 * jsdom cannot do meaningfully - see this file's own doc comment.
 */
export type TileVisual = 'image' | 'icon' | 'blank'

export function tileVisual(item: Pick<MediaListItem, 'imageUrl' | 'placeholderIcon'>): TileVisual {
  if (item.imageUrl) return 'image'
  if (item.placeholderIcon) return 'icon'
  return 'blank'
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
  /**
   * Splits each row into two INDEPENDENT hit targets - the leading
   * image/icon/blank box, and the text column beside it - instead of the
   * default single hit object covering the whole row. When provided,
   * clicking the image calls THIS callback and clicking the text column
   * calls `onSelect`; when omitted (every caller but `ChaptersWindow`), the
   * row keeps its original one-hit-object behaviour byte-for-byte, and
   * `onSelect` alone still fires for a click anywhere on the row.
   *
   * Added for directive 2 ("beim anklicken des Bildes zu dem Kapitel
   * kommen, beim anklicken des Textes zu der Stelle wo der Untertitel
   * spielt") - `ChaptersWindow` is the one window in this app whose tiles
   * carry both a real preview image AND text (see that component's own doc
   * comment for why `TranscriptWindow`, which has no images at all, is not
   * this feature's home).
   *
   * The two regions are genuine SEPARATE `Container`s, each with its own
   * `backgroundColor`/`hover` pair - not two children of one still-single
   * hit object with `pointerEvents` toggled between them. That distinction
   * matters: `@pmndrs/pointer-events` resolves a click/hover against
   * whichever Object3D the ray actually intersects, and two visually
   * adjacent regions that both belong to the SAME underlying hit object
   * cannot have their hover states told apart from one another - exactly
   * the trap `IconButton`'s and this file's own "one hit object" doc
   * comments describe from the other direction (collapsing several
   * children INTO one object, on purpose, so a press/release pair always
   * resolves the same way). Splitting the row is the deliberate opposite
   * move, so each region's own `hover` genuinely only lights up that
   * region.
   */
  onSelectImage?: (id: string) => void
}

const RESTING_BG = '#20202a'
const HOVER_BG = '#2c2c3a'
const ACTIVE_BG = '#3a4f7f'

const TILE_IMAGE_W = 96
const TILE_IMAGE_H = 54

/** The tinted "no thumbnail, on purpose" panel - see `placeholderIcon`. Deliberately
 * NOT `#101014` (the plain missing-image box below): that grey is a broken/absent
 * state, and reusing it here would make a designed placeholder read as one too. */
const PLACEHOLDER_BG = '#232c3a'
const PLACEHOLDER_ICON_COLOR = '#7f93c9'

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
 * Reusable uikit tile list: a scrollable column of leading-box+two-line-Text
 * tiles with a hover cue, and an optional "Mehr laden" tail button. The
 * leading box is a real `Image` when `imageUrl` is set, the tinted
 * `placeholderIcon` panel when the caller says a thumbnail was never going to
 * exist, or the plain grey box for a thumbnail that merely failed to show up
 * - see `tileVisual`. Used by LibraryWindow at both the series and the
 * episode level; SeriesWindow (Task 14) reuses it directly with no wrapper
 * tile type of its own - ChaptersWindow (also Task 14) goes through it too,
 * feeding it segment tiles built by `chaptersState.ts`. This component still
 * knows nothing about series/episodes/segments/playability, only about tiles
 * (plus, as of Task 14, which one of them is "active" - see `activeId`, and
 * as of the split-click round, whether image and text are two independent
 * hit targets - see `onSelectImage`).
 */
export function MediaList({ items, onSelect, onSelectImage, onMore, moreLabel, emptyText, activeId }: MediaListProps) {
  const splitClick = onSelectImage != null
  return (
    <Container flexGrow={1} flexDirection="column" overflow="scroll" padding={12} gap={8}>
      {items.length === 0 ? (
        <Text fontSize={14} color="#9a9aa5">{emptyText}</Text>
      ) : (
        items.map((item) => {
          const active = item.id === activeId
          const visual = tileVisual(item)

          const visualBox =
            visual === 'image' ? (
              <Image
                src={item.imageUrl} width={TILE_IMAGE_W} height={TILE_IMAGE_H} borderRadius={4}
                pointerEvents={DECORATIVE_POINTER_EVENTS}
              />
            ) : visual === 'icon' ? (
              <Container
                width={TILE_IMAGE_W} height={TILE_IMAGE_H} backgroundColor={PLACEHOLDER_BG} borderRadius={4}
                alignItems="center" justifyContent="center"
                pointerEvents={DECORATIVE_POINTER_EVENTS}
              >
                {item.placeholderIcon && (
                  <item.placeholderIcon
                    width={20} height={20} color={PLACEHOLDER_ICON_COLOR}
                    pointerEvents={DECORATIVE_POINTER_EVENTS}
                  />
                )}
              </Container>
            ) : (
              <Container
                width={TILE_IMAGE_W} height={TILE_IMAGE_H} backgroundColor="#101014" borderRadius={4}
                pointerEvents={DECORATIVE_POINTER_EVENTS}
              />
            )

          const textBlock = (
            <>
              <Text fontSize={14} color="#ffffff">{truncate(item.title, TITLE_MAX_CHARS)}</Text>
              {item.subtitle != null && (
                <Text fontSize={11} color="#9a9aa5">{truncate(item.subtitle, SUBTITLE_MAX_CHARS)}</Text>
              )}
            </>
          )

          if (!splitClick) {
            return (
              <Container
                key={item.id}
                flexDirection="row"
                gap={10}
                padding={8}
                // Same UIKIT-NOTES entry-8 guard as the split-click branch
                // below: auto-height rows in a column default to
                // flexShrink 1 and get squashed as the list grows - the
                // library and series lists are exactly the ones that grow.
                flexShrink={0}
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
                {visualBox}
                <Container
                  flexDirection="column" gap={2} flexGrow={1}
                  pointerEvents={DECORATIVE_POINTER_EVENTS}
                >
                  {textBlock}
                </Container>
              </Container>
            )
          }

          // Split-click mode (`onSelectImage` provided - ChaptersWindow only,
          // see the prop's own doc comment): the image and text regions are
          // now two GENUINE separate hit objects, each carrying its own
          // background/hover pair, rather than two children opted OUT of
          // hit-testing under one shared row. The outer row is a plain
          // grouping Container with no background/hover/onClick of its own -
          // giving it one would put a THIRD, larger hit object underneath the
          // other two, which is exactly the "same underlying Object3D"
          // bleed this mode exists to avoid.
          return (
            // `flexShrink={0}` - see `docs/UIKIT-NOTES.md` entry 8: a uikit
            // scrolling column's children default to `flexShrink: 1`, so a
            // LONG list (many tiles) proportionally squashes every row's
            // auto-height to fit the column's own box instead of letting the
            // column genuinely overflow and scroll - found and fixed in
            // `TranscriptWindow.tsx`'s rows, applied here defensively since
            // this component backs every long list in the app (the library,
            // a series' episodes, chapters) and none of them are exercised
            // with enough real items in this repo's own fixtures to have hit
            // the threshold live.
            <Container key={item.id} flexShrink={0} flexDirection="row" gap={10} alignItems="stretch">
              <Container
                padding={4}
                borderRadius={6}
                alignItems="center"
                justifyContent="center"
                backgroundColor={active ? ACTIVE_BG : RESTING_BG}
                hover={{ backgroundColor: active ? ACTIVE_BG : HOVER_BG }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectImage(item.id)
                }}
              >
                {visualBox}
              </Container>
              <Container
                flexDirection="column"
                gap={2}
                flexGrow={1}
                padding={8}
                borderRadius={6}
                justifyContent="center"
                backgroundColor={active ? ACTIVE_BG : RESTING_BG}
                hover={{ backgroundColor: active ? ACTIVE_BG : HOVER_BG }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(item.id)
                }}
              >
                <Container flexDirection="column" gap={2} pointerEvents={DECORATIVE_POINTER_EVENTS}>
                  {textBlock}
                </Container>
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
