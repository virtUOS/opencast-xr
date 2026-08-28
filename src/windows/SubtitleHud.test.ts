import { describe, expect, it } from 'vitest'
import { CAPTION_DESIGN, CAPTION_TEXT_MAX_WIDTH } from './SubtitleHud'

// `SubtitleHud.tsx` renders `@react-three/uikit` primitives, which - like the
// rest of this app's uikit trees (see `docs/UIKIT-NOTES.md`) - cannot
// meaningfully render or line-break in jsdom: there is no WebGL context, no
// font atlas, and Yoga's own layout pass never runs. So this file does NOT
// (and cannot) assert that a long cue actually wraps on screen. What it CAN
// pin down is the one number the wrapping fix depends on -
// `CAPTION_TEXT_MAX_WIDTH`, the `maxWidth` handed to the caption `<Text>`
// itself (see that constant's own doc comment in `SubtitleHud.tsx` for the
// full uikit root-cause: an ancestor `Container`'s `maxWidth` alone does not
// make a child `<Text>` wrap without a `stretch`ed, definite-width ancestor,
// but a `maxWidth` on the `<Text>` node itself does, regardless).
//
// That the JSX actually WIRES this constant onto the `<Text>` node (rather
// than, say, silently applying it to the wrong element) was verified by
// reading `SubtitleHud.tsx`'s render, not by a test here - there is no seam
// short of a real WebGL-backed uikit render (out of reach in this jsdom
// suite) that could exercise the JSX itself.
describe('CAPTION_TEXT_MAX_WIDTH', () => {
  it('is strictly narrower than the panel\'s own maxWidth', () => {
    // The whole fix rests on this: the TEXT's own bound has to be reached
    // before the PANEL's outer maxWidth would otherwise just clip/overflow
    // one unwrapped line. Equal or wider would silently undo the fix even
    // though the prop is still present on the JSX.
    expect(CAPTION_TEXT_MAX_WIDTH).toBeLessThan(CAPTION_DESIGN.maxWidth)
  })

  it('is exactly the panel maxWidth minus both horizontal paddings', () => {
    // The content box a wrapped line actually has to fit inside - not the
    // panel's own (padding-inclusive) maxWidth. A future edit to
    // CAPTION_DESIGN that forgets this relationship (e.g. copies maxWidth
    // straight onto the Text) has to fail here.
    expect(CAPTION_TEXT_MAX_WIDTH).toBe(CAPTION_DESIGN.maxWidth - CAPTION_DESIGN.paddingX * 2)
  })

  it('stays comfortably positive', () => {
    // A zero-or-negative Text maxWidth is this codebase's usual silent-vanish
    // failure mode (see captionScale.ts's NaN guards) - uikit would lay the
    // caption out as nothing rather than erroring. Guards against a future
    // paddingX bump swallowing the whole content box.
    expect(CAPTION_TEXT_MAX_WIDTH).toBeGreaterThan(CAPTION_DESIGN.fontSize * 4)
  })
})
