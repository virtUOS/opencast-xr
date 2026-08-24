/**
 * ## Caption size and vertical position: the scale, the offset, and why the
 * numbers are what they are
 *
 * A leaf module on purpose. `subtitleScale`/`subtitleOffsetDeg` live on the
 * player store (one writer each), the controls that change them are in
 * `windows/DockTransport.tsx`, and the thing they change is
 * `windows/SubtitleHud.tsx` - so the constants have to be reachable from both
 * `player/` and `windows/`. Sitting at `src/` with no imports of its own, this
 * module keeps `player/store.ts` from having to import out of `windows/`
 * against this app's usual direction - the same arrangement as `src/time.ts`.
 *
 * ### The size mechanism the numbers refer to
 *
 * `subtitleScale` multiplies the caption panel's own design pixels - font size,
 * padding, corner radius and `maxWidth` all by the SAME factor (see
 * `SubtitleHud.tsx`). Scaling every one of them together is what makes it a
 * uniform scale rather than a reflow: uikit's layout is linear in px, so a
 * `fontSize * k` with a `maxWidth * k` breaks lines at exactly the same words,
 * and uikit draws glyphs from an SDF atlas, so the result stays crisp at any
 * factor.
 *
 * ### Why the scale is well under 1
 *
 * The raw design size is enormous in world space: the caption panel is
 * `CAPTION_MAX_WIDTH_PX` + padding wide at uikit's fixed 0.01 m/px - about
 * 5.6 m - hanging 1.2 m from the viewer, where the magic window's own
 * 70-degree frustum is only about 2.7 m wide. That is the „passen nicht in das
 * Browserfenster" the user reported. So `1.0` is not a sensible default here.
 *
 * ### From three steps to a continuous ladder (Quest feedback, round 2)
 *
 * This used to be three fixed steps (S 0.18 / M 0.24 / L 0.32) behind one
 * cycling button. Judged through the headset's lenses, „L ist zu gross ... S ist
 * gefuehlt auch noch ein wenig zu gross", and the ask was for plain `-`/`+`
 * buttons instead of a cycle. So:
 *
 * - the ladder is now MULTIPLICATIVE - one press changes the caption by
 *   `CAPTION_SCALE_STEP` (12 %) of its current size. A fixed additive step
 *   cannot serve both ends of a 3.5x range: 0.02 is a 22 % jump at the small
 *   end and a 6 % nudge at the large one. A constant ratio is the same
 *   perceived change everywhere, which is what „einfach einstellbar" means when
 *   the user cannot see a number;
 * - `DEFAULT_CAPTION_SCALE` is **0.16** - just below the old S (0.18), which is
 *   the direction the feedback points, without overshooting into illegible;
 * - `MIN_CAPTION_SCALE` is **0.09**, well below the new default (five presses),
 *   because „a wenig zu gross" is a judgement made through lenses this project
 *   cannot see through, and the floor has to leave room for it to be wrong
 *   again in the same direction;
 * - `MAX_CAPTION_SCALE` stays **0.32**. It was measured, not guessed: at 0.40
 *   the panel is 2.07 m wide, 102 % of a 4:3 canvas, and clips both edges
 *   (measured `insideCanvas: false`, NDC x spanning -1.019..1.017). 0.32 is the
 *   largest step that clears both edges at the narrow aspect.
 *
 * ### The measurements the range came from
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
 * ### The vertical offset
 *
 * `subtitleOffsetDeg` is added to `<HeadLocked>`'s `offsetPitchDeg`, which is
 * where the HUD rests relative to the smoothed gaze direction (sphere-shell's
 * `DEFAULT_HEADLOCKED.offsetPitchDeg` is -15, i.e. „below the primary
 * content"). POSITIVE moves the caption UP, negative down, which is the way
 * round the dock's up/down buttons read.
 *
 * The range is deliberately asymmetric-free and modest: +-12 degrees around the
 * default, in 3-degree steps (four presses each way). Beyond about +12 the
 * caption crosses the middle of the field of view - i.e. lands on the video it
 * is captioning - and below about -27 total it is at the elevation the dock
 * itself occupies (-30). Neither is a state a control should be able to reach
 * by holding a button down.
 */

/** The smallest and largest caption scale the store will accept. See above. */
export const MIN_CAPTION_SCALE = 0.09
export const MAX_CAPTION_SCALE = 0.32

/** Where the caption starts, before the user touches anything. */
export const DEFAULT_CAPTION_SCALE = 0.16

/**
 * One press of `-`/`+`: a 12 % change of the CURRENT size, not a fixed
 * increment - see the doc comment for why the ladder is multiplicative.
 */
export const CAPTION_SCALE_STEP = 0.12

/**
 * The caption scale one press away from `scale`.
 *
 * @param direction `+1` for larger, `-1` for smaller. Any other value is
 *   treated as its sign, so a caller cannot accidentally take a double step.
 *
 * Clamped to `[MIN_CAPTION_SCALE, MAX_CAPTION_SCALE]`, and a non-finite input
 * lands on the default rather than propagating: a `NaN` reaching the HUD's own
 * pixel arithmetic makes the caption silently vanish (uikit lays out a `NaN`
 * font size as nothing at all), which is the worst possible failure for a
 * subtitle - no error, no console warning, just gone.
 *
 * Stepping DOWN from a value already at the floor returns the floor, so the
 * button is idempotent rather than oscillating; the dock disables it there
 * anyway, but the guarantee belongs here where it is testable.
 */
export function stepCaptionScale(scale: number, direction: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_CAPTION_SCALE
  const factor = direction >= 0 ? 1 + CAPTION_SCALE_STEP : 1 / (1 + CAPTION_SCALE_STEP)
  return clampCaptionScale(scale * factor)
}

/** `scale`, forced into the accepted range; a non-finite value becomes the default. */
export function clampCaptionScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_CAPTION_SCALE
  return Math.min(MAX_CAPTION_SCALE, Math.max(MIN_CAPTION_SCALE, scale))
}

/**
 * What the dock shows between the `-` and `+` buttons: the caption's size as a
 * percentage OF THE DEFAULT, e.g. „100%" at the default and „112%" one press up.
 *
 * A percentage rather than the raw factor (0.16 means nothing to anyone) and
 * relative to the default rather than to the maximum, because „am I above or
 * below normal, and by how much" is the only question this readout has to
 * answer - and it is the question someone re-finding a size they liked asks.
 * Plain ASCII digits and a `%`; see `docs/UIKIT-NOTES.md` entry 3.
 */
export function captionScaleLabel(scale: number): string {
  const safe = Number.isFinite(scale) ? scale : DEFAULT_CAPTION_SCALE
  return `${Math.round((safe / DEFAULT_CAPTION_SCALE) * 100)}%`
}

/** How far up or down one press of the caption's position buttons moves it, in degrees. */
export const CAPTION_OFFSET_STEP_DEG = 3
/** The furthest the caption can be nudged from its default resting pitch. See the doc comment. */
export const MAX_CAPTION_OFFSET_DEG = 12
export const MIN_CAPTION_OFFSET_DEG = -MAX_CAPTION_OFFSET_DEG
/** Where the caption sits before the user touches anything: exactly `<HeadLocked>`'s own default. */
export const DEFAULT_CAPTION_OFFSET_DEG = 0

/**
 * The caption's vertical offset one press away from `offsetDeg`.
 *
 * @param direction `+1` for up, `-1` for down.
 *
 * Same guarantees as `stepCaptionScale`: clamped, idempotent at either end, and
 * a non-finite input lands on the default (a `NaN` pitch would send the HUD to
 * an undefined place on the sphere, or make `placeHeadLocked` produce a `NaN`
 * position, which again means "the caption is simply gone").
 */
export function stepCaptionOffset(offsetDeg: number, direction: number): number {
  if (!Number.isFinite(offsetDeg)) return DEFAULT_CAPTION_OFFSET_DEG
  const delta = direction >= 0 ? CAPTION_OFFSET_STEP_DEG : -CAPTION_OFFSET_STEP_DEG
  return clampCaptionOffset(offsetDeg + delta)
}

/** `offsetDeg`, forced into the accepted range; a non-finite value becomes the default. */
export function clampCaptionOffset(offsetDeg: number): number {
  if (!Number.isFinite(offsetDeg)) return DEFAULT_CAPTION_OFFSET_DEG
  return Math.min(MAX_CAPTION_OFFSET_DEG, Math.max(MIN_CAPTION_OFFSET_DEG, offsetDeg))
}
