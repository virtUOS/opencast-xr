import { describe, expect, it } from 'vitest'
import { tileVisual } from './MediaList'

// MediaList itself can't be rendered meaningfully under jsdom (uikit is a
// react-three-fiber tree, not DOM - see MediaList.tsx's own doc comment), so
// this file only exercises the one piece of real decision logic that moved
// out of the JSX for exactly that reason: which of the three leading-box
// visuals a tile gets. See `placeholderIcon`'s doc comment on MediaListItem
// for what each case means (a real preview vs. a deliberate "no thumbnail"
// design vs. a thumbnail that simply failed to show up).
describe('tileVisual', () => {
  it('is "image" whenever imageUrl is set, regardless of placeholderIcon', () => {
    expect(tileVisual({ imageUrl: 'https://example.org/p.jpg' })).toBe('image')
    // imageUrl wins even if a caller (accidentally) supplied both - a real
    // preview is always preferred over a placeholder.
    expect(tileVisual({ imageUrl: 'https://example.org/p.jpg', placeholderIcon: FakeIcon })).toBe('image')
  })

  it('is "icon" when there is no imageUrl but a placeholderIcon was supplied - the series-tile case', () => {
    expect(tileVisual({ placeholderIcon: FakeIcon })).toBe('icon')
  })

  it('is "blank" (the old plain grey box) when neither is set - a thumbnail that should exist but does not', () => {
    expect(tileVisual({})).toBe('blank')
    expect(tileVisual({ imageUrl: undefined, placeholderIcon: undefined })).toBe('blank')
  })
})

// A stand-in for a lucide icon component - tileVisual never calls it, only
// checks whether the slot is filled, so an arbitrary function is enough.
function FakeIcon() {
  return null
}
