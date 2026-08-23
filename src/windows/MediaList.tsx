import { Container, Text, Image } from '@react-three/uikit'

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
}

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
 * (Task 14) is expected to reuse it unchanged - this component knows nothing
 * about series/episodes/playability, only about tiles.
 */
export function MediaList({ items, onSelect, onMore, moreLabel, emptyText }: MediaListProps) {
  return (
    <Container flexGrow={1} flexDirection="column" overflow="scroll" padding={12} gap={8}>
      {items.length === 0 ? (
        <Text fontSize={14} color="#9a9aa5">{emptyText}</Text>
      ) : (
        items.map((item) => (
          <Container
            key={item.id}
            flexDirection="row"
            gap={10}
            padding={8}
            alignItems="center"
            backgroundColor="#20202a"
            borderRadius={6}
            hover={{ backgroundColor: '#2c2c3a' }}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(item.id)
            }}
          >
            {item.imageUrl ? (
              <Image src={item.imageUrl} width={TILE_IMAGE_W} height={TILE_IMAGE_H} borderRadius={4} />
            ) : (
              <Container width={TILE_IMAGE_W} height={TILE_IMAGE_H} backgroundColor="#101014" borderRadius={4} />
            )}
            <Container flexDirection="column" gap={2} flexGrow={1}>
              <Text fontSize={14} color="#ffffff">{truncate(item.title, TITLE_MAX_CHARS)}</Text>
              {item.subtitle != null && (
                <Text fontSize={11} color="#9a9aa5">{truncate(item.subtitle, SUBTITLE_MAX_CHARS)}</Text>
              )}
            </Container>
          </Container>
        ))
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
          <Text fontSize={13} color="#ffffff">{moreLabel ?? 'Mehr laden'}</Text>
        </Container>
      )}
    </Container>
  )
}
