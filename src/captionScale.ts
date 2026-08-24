/**
 * ## Caption size: the steps, and why they are all well under 1
 *
 * A leaf module on purpose. `subtitleScale` lives on the player store (one
 * writer, `setSubtitleScale`), the control that changes it is in
 * `windows/DockTransport.tsx`, and the thing it changes is
 * `windows/SubtitleHud.tsx` - so the constants have to be reachable from both
 * `player/` and `windows/`. They started out in `windows/subtitleHudState.ts`,
 * which forced `player/store.ts` to import from `windows/` against this app's
 * usual direction (windows read the store, not the other way round). Sitting at
 * `src/` with no imports of its own, this module removes that exception rather
 * than documenting it - and it is the same shape as `src/time.ts`, the other
 * thing both layers need.
 *
 * ### The mechanism the numbers refer to
 *
 * `subtitleScale` multiplies the caption panel's own design pixels - font size,
 * padding, corner radius and `maxWidth` all by the SAME factor (see
 * `SubtitleHud.tsx`). Scaling every one of them together is what makes it a
 * uniform scale rather than a reflow: uikit's layout is linear in px, so a
 * `fontSize * k` with a `maxWidth * k` breaks lines at exactly the same words,
 * and uikit draws glyphs from an SDF atlas, so the result stays crisp at any
 * factor.
 *
 * It used to be a `<group scale>` around the whole `<HeadLocked>`, which
 * sphere-shell's README documents as the supported way to resize a head-locked
 * container. That worked, but it also scaled the seek-feedback panel that
 * shares the HUD - and the user asked for adjustable SUBTITLES, not adjustable
 * scrub feedback. Multiplying the caption panel's own pixels confines the
 * change to the caption. The world sizes below are unaffected: px * 0.01 m/px
 * is the same number either way, and they were re-measured after the switch.
 *
 * ### Why the steps are all well under 1
 *
 * The raw design size is enormous in world space: the caption panel is
 * `CAPTION_MAX_WIDTH_PX` + padding wide at uikit's fixed 0.01 m/px - about
 * 5.6 m - hanging 1.2 m from the viewer, where the magic window's own
 * 70-degree frustum is only about 2.7 m wide. That is the „passen nicht in das
 * Browserfenster" the user reported. So `1.0` is not a sensible default here.
 *
 * ### The measurements these came from
 *
 * Measured live in the magic window (world AABB of the caption panel's own
 * subtree, projected through the live camera) at 640x480 - aspect 1.33, the
 * NARROW case, since the caption's world width is fixed while the frustum's
 * width grows with aspect:
 *
 * | scale | panel width | % of canvas width @4:3 | @16:9 |
 * |-------|-------------|------------------------|-------|
 * | 0.18  | 0.93 m      | 44 %                   | 33 %  |
 * | 0.24  | 1.24 m      | 60 %                   | 45 %  |
 * | 0.32  | 1.66 m      | 80 %                   | 60 %  |
 * | 0.40  | 2.07 m      | 102 % - CLIPPED        | 76 %  |
 *
 * (@4:3 columns measured; @16:9 derived from them by the frustum's own width
 * ratio, since the panel's world width does not depend on aspect. Widths are
 * for a two-line cue at the panel's full width; a shorter cue is narrower.)
 *
 * 0.4 was the first draft's largest step and it does not fit a 4:3 window at
 * all (measured `insideCanvas: false`, NDC x spanning -1.019..1.017), which is
 * exactly the reported bug in miniature - hence the ladder below stops at 0.32,
 * where even the largest step clears both edges at 4:3.
 *
 * RETUNED BROWSER-FIRST. The Quest look is unverified - a headset renders each
 * eye through its own narrower frustum, so these may well read as too SMALL
 * there. See `docs/QUEST-VALIDATION-PLAYER.md`.
 */

// Typed `readonly number[]` rather than `as const`: a tuple of literal types
// would make every derived constant (the default, MIN/MAX) a literal type too,
// which then fights every ordinary `number` it is compared or assigned to.
export const CAPTION_SCALE_STEPS: readonly number[] = [0.18, 0.24, 0.32]

/** One-character labels for `CAPTION_SCALE_STEPS`, index for index - short enough for a dock button. */
export const CAPTION_SCALE_LABELS: readonly string[] = ['S', 'M', 'L']

/** The default caption size: the middle step. */
export const DEFAULT_CAPTION_SCALE = CAPTION_SCALE_STEPS[1]

/** Smallest/largest caption scale the store will accept - the ends of `CAPTION_SCALE_STEPS`, exported so the store can clamp without reasoning about the whole steps array. */
export const MIN_CAPTION_SCALE = CAPTION_SCALE_STEPS[0]
export const MAX_CAPTION_SCALE = CAPTION_SCALE_STEPS[CAPTION_SCALE_STEPS.length - 1]

/**
 * Which step a scale value corresponds to - the NEAREST one, not an exact
 * match. The store holds a plain clamped number rather than an index (one
 * writer, one value, no "index into an array the store cannot see"), so this
 * has to cope with a value that is not exactly a step: a clamp landing between
 * two of them, or a step list that changed under a value from an earlier build.
 * Nearest keeps the label and the next cycle step sane in all of those cases
 * instead of falling back to step 0 and silently resetting the user's choice.
 */
export function captionScaleIndex(scale: number): number {
  if (!Number.isFinite(scale)) return CAPTION_SCALE_STEPS.indexOf(DEFAULT_CAPTION_SCALE)
  let best = 0
  for (let i = 1; i < CAPTION_SCALE_STEPS.length; i++) {
    if (Math.abs(CAPTION_SCALE_STEPS[i] - scale) < Math.abs(CAPTION_SCALE_STEPS[best] - scale)) best = i
  }
  return best
}

/**
 * The next size step, wrapping round from the largest back to the smallest -
 * so the dock needs ONE button for caption size rather than a -/+ pair, which
 * matters on a row that already carries play/pause, the timeline, the time
 * readout, mute and volume. Three steps make the wrap cheap: the worst case
 * for reaching any size is two clicks.
 */
export function cycleCaptionScale(scale: number): number {
  return CAPTION_SCALE_STEPS[(captionScaleIndex(scale) + 1) % CAPTION_SCALE_STEPS.length]
}

/** The one-character label for the step `scale` is on ("S"/"M"/"L") - what the dock's size button displays. */
export function captionScaleLabel(scale: number): string {
  return CAPTION_SCALE_LABELS[captionScaleIndex(scale)]
}
