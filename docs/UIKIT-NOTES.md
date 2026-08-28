# `@react-three/uikit`/`@pmndrs/uikit` gotchas

Real, reproduced defects and quirks in the installed `@react-three/uikit`
1.0.74 (`@pmndrs/uikit` 1.0.74) that have cost more than one task each. Each
entry: the symptom, the root cause (where known), and the fix/workaround.
Update this file, don't re-discover an entry from scratch in a future task.

## 1. Never pass `hover={undefined}` conditionally

**Symptom:** toggling a `hover` prop between an object and `undefined` on
different renders (e.g. `hover={disabled ? undefined : {backgroundColor}}`,
meant as "no hover highlight while disabled") crashes the whole scene, but
not immediately - a few hundred ms LATER, during an unrelated tree
replacement (in the reproduction: `LibraryWindow` unmounting while
`VideoWindows`+another window mounted in the same commit).
`Uncaught TypeError: Cannot convert undefined or null to object` inside
`@react-three/fiber`'s reconciler `removeChild`, several frames deep.

**Found in:** the opencast player's `ControlsWindow.tsx` (Task 13), subtitle
toggle's disabled-hover state.

**Root cause:** not traced into uikit's own source. Bisected by elimination
(stub → add pieces one at a time, each run against a FRESH dev server + hard
reload, several trials each, specifically to rule out HMR/timing noise as a
confound) to this exact prop - reverting only `hover` from a
conditional-`undefined` ternary to an always-present object, while leaving
every conditional *child* in the same component untouched, made the crash
disappear across every subsequent trial.

**Fix:** keep `hover` (and, by the same logic, any other uikit
event/style prop that's normally an object) a plain object on every render.
Encode "no visible hover" by making the object's own values match the
resting state instead of omitting the prop:
```tsx
hover={{ backgroundColor: disabled ? restingColor : hoverColor }}
```

## 2. Cumulative wrapped-visual-line count in one scrolling column can render blank

**Symptom:** a `Container overflow="scroll"` column whose children include
several *long* text blocks that each wrap across multiple visual lines
renders **completely blank** once the cumulative wrapped-line count in that
one column gets large enough (roughly: a handful of blocks worked, ~30
already showed overlap/garbling, ~40 long blocks - on the order of 100+
total visual lines - went fully blank). No console errors.

**Found in:** sphere-shell's `MarkdownContent` (design/demo phase, Task 14).
Scene-graph introspection found the mechanism: uikit allocates a glyph
instance batch with the correct character count, but for the overflowing
content that batch ships with `visible: false` and every instance matrix
zeroed - i.e. it never computed valid per-glyph transforms before the
scroll container's clipping check ran, so the batch is clipped away as if it
never existed.

**What it is NOT:** sibling fan-out. A flat column of ~40 short,
*single-line* `<Text>` nodes renders perfectly; nesting long blocks into
grouping "chunk" containers to reduce direct sibling count only reduced
blank-to-overlap, it didn't fix it. The variable is total wrapped-line
volume in one scrolling subtree, not node count.

**Fix/workaround:** no library-level fix applied (out of scope for the task
that found it). The demo's own long-form markdown content was kept
short-lined per paragraph (each line well under the panel width, so it
doesn't wrap) to stay under the threshold. A player window rendering
real, long-form content (transcripts, chapter lists) should watch for this -
either keep paragraphs short-lined, split across multiple scroll
containers/pages, or budget time to investigate a uikit upgrade/patch if it
recurs.

## 3. Missing glyphs ("tofu boxes") for punctuation outside plain ASCII

**Symptom:** certain non-ASCII characters render as small filled-square
placeholders (and log `Missing glyph info for character "X"` to the
console) instead of the intended glyph, in this project's installed uikit
default font.

**Confirmed missing:** `‹` (U+2039), `·` (U+00B7, middle dot), `…` (U+2026,
ellipsis), `•`, `→`, `✕`, `–` (en dash).

**Confirmed FINE:** plain ASCII, and accented Latin letters/umlauts (`ü`,
`ö`, `ä`, `ß`) - e.g. `libraryState.ts`'s `toEpisodeTile` uses `" - "` for
`"·"` and `MediaList.tsx`'s `truncate` uses `"..."` for `"…"`, both
live-verified against the real server. The defect is about typographic
PUNCTUATION outside Latin-1/ASCII, not diacritics in general.
(`LibraryWindow.tsx`'s back button no longer needs this workaround at all -
a later round swapped its `"< Zurück"` text hack for a real `ChevronLeft`
icon, which sidesteps the font defect entirely; see `Icon-based
alternatives` below.)

**Fix:** use the plain-ASCII substitute for any of the confirmed-missing
characters above (`<` for `‹`, ` - ` for `·`, `...` for `…`, `x` for `✕`,
`-` for `–`, etc.) at the point where the string is defined, with a comment
citing this entry. Icon-based alternatives (lucide, `Svg extends Content`)
are unaffected - they're not text glyphs at all.

## 4. `e.point` vs `e.ray`: capture-safety and curved-mode correction pull in OPPOSITE directions

Two related, but distinct, problems with reading pointer position from a
uikit event - both real, both found in the same component
(`src/windows/DockTransport.tsx`'s timeline scrubber),
and they don't have one shared fix. Know which one you're solving for.

### 4a. `e.point` freezes during a pointer-captured drag (round 1)

**Symptom:** computing a drag's world-space hit point from a uikit pointer
event's `e.point` (the `Intersection.point` r3f's raycaster captured) works
for a plain click, but during a `setPointerCapture`-based drag it silently
STOPS updating once the pointer moves outside the captured element's own
mesh bounds - every subsequent `move`/`up` event reports the exact same
`point` as the original `pointerdown`, bit-for-bit, instead of the pointer's
actual current position.

**Found in:** the opencast player's `DockTransport.tsx` timeline scrubber
(Task 13, code review round 1) - a drag continuing past either edge of the
(finite) track mesh got stuck instead of clamping to 0/duration.

**Root cause:** r3f's `capturedMap` falls back to the intersection captured
ONCE at `pointerdown` for a captured pointer once the raycaster's fresh
hit-test against the actual mesh stops succeeding (pointer has left its
bounds) - `point` (and other `Intersection` fields) is never recomputed in
that fallback path. `e.ray`, by contrast, IS recomputed every frame from the
current pointer position and camera, regardless of capture - this is
exactly why `useDragOnSphere.ts`/`useResizeOnSphere.ts` intersect `e.ray`
against their own geometry rather than reading `e.point`.

**Fix:** for anything that reads pointer position across a captured,
potentially-off-element drag, intersect `e.ray.origin`/`e.ray.direction`
against your own target geometry (a plane, a sphere, whatever the drag
target actually is) instead of reading `e.point`. See
`src/windows/timelineDrag.ts`'s `rayToTrackFraction`
for a worked example (ray vs. a uikit `Container`'s plane, converted to the
container's local space via its `matrixWorld`).

### 4b. Switching to `e.ray` regresses plain clicks under sphere-shell's EXPERIMENTAL curved mode (round 2)

**Symptom:** after applying 4a's fix (read `e.ray`, intersect the FLAT
plane), a plain click - no drag, no capture - lands at the wrong fraction
whenever the containing panel (a window, or sphere-shell's own dock) is
currently rendered with the cylindrical bend (`curved={true}` on
`<WindowShell>`, or the in-scene "Curved" toggle sphere-shell's own dock
provides - the latter can be on regardless of the app's initial prop). The
error is zero at the panel's own centre and grows outward, worst near an
edge - exactly `core/cylindricalBend.ts`'s documented `flatXForBentX` sag.

**Root cause:** sphere-shell's own hit-testing (`patchRaycastForBend` in
`cylindricalBendShader.ts`) already corrects for this, but not in a way
that survives being read back out generically. It substitutes a
bend-corrected ray, runs uikit's stock FLAT-quad raycast against that
substitute, and lets it write the resulting `Intersection.point` (now
bend-corrected, in world space) - then, in a `finally` block, restores
`ray.direction` back to the TRUE, uncorrected ray BEFORE returning, so that
`e.ray` - which every OTHER consumer (`useDragOnSphere`, `useResizeOnSphere`,
and now our own `rayToTrackFraction`) reads - is deliberately left
uncorrected. In other words: `e.point` carries the bend correction baked in
as a one-time snapshot; `e.ray` never does. There is no field on the event
that is BOTH capture-safe (fix 4a's requirement) AND bend-corrected (this
fix's requirement) - a correct fix has to redo the bend math itself, the
same way `patchRaycastForBend` does, using `e.ray` and the panel's own
bend-frame (radius + world transform), not read either field naively.

**Status: NOT fixed, by design - missing sphere-shell API.** A correct fix
means intersecting `e.ray` against the actual cylinder the panel is bent
onto (the analogue of `useDragOnSphere` intersecting the shell sphere) and
mapping the hit back to local X. For a plain window that is straightforward
- the same group `useCylindricalBend` was called on for that window is
reachable from inside it. For the DOCK specifically it is not: the dock's
own bend group (`Dock.tsx`'s internal `groupRef`, positioned via
`panelTransform({azimuth: 0, elevation: DOCK_ELEVATION}, ...)`) is private
to `Dock.tsx`. `useShellContext()` exposes only `anchorRef` - the shell's
anchor, a DIFFERENT and unrotated ancestor; the dock's nonzero elevation
tilts its own local Y away from the anchor's/world's vertical, so building
the cylinder from `anchorRef` alone uses the wrong axis. Nothing sphere-shell
exports today reaches the dock's own bend transform (its `matrixWorld` or
live `BendUniforms`) from code rendered inside the `dockControls` slot.
Reported to the opencast-player task's controller as `NEEDS_CONTEXT`
instead of shipped as an approximation (`Dock.tsx`'s own private layout
constants would ALSO still be missing this specific track's live offset
within the dock's flex row - not obtainable without re-running uikit's
layout). See `DockTransport.tsx`'s own doc comment and
`.superpowers/sdd/2026-08-23-opencast-player/task-13-report.md` for the
proposed API shape (something like a `useDockBendFrame()` hook, or exposing
the dock's bend group/uniforms via `useShellContext()`).

**Practical effect today:** flat mode (default, shipped) is exact. Curved
mode's scrubbing stays directionally correct and monotonic but is
numerically off near a panel's edges - a `curved`-only degradation, not a
crash or a stuck preview.

## 5. `onClick` needs a native `click` event - a synthetic pointerdown+pointerup pair is NOT enough

**Symptom:** driving the scene from the browser console (the only way this
project can verify anything on screen - see `verificationHandle.tsx`), a
hand-dispatched `pointerdown` + `pointerup` pair on the canvas at a uikit
control's exact position does everything EXCEPT fire its `onClick`. Hover
works, so it is provably not a coordinate or hit-testing problem: the same
position lights the control's `hover` background (measured with
`gl.readPixels`: `#2f6f4f` -> `#3f9f6f`, exactly the configured pair), and
r3f's own `pointer` NDC matches the intended CSS position to 3 decimals. The
control simply never acts.

**Found in:** the dock UX round's live verification of
`DockTransport.tsx` - it cost most of an hour and was very nearly written up
as "uikit hit-testing is dead in the automation browser" (it is not).

**Root cause:** `@pmndrs/pointer-events` - which is what handles pointer input
for uikit, replacing r3f's own event manager - FORWARDS the native `click`
event rather than synthesising one from a pointerdown/pointerup pair. No
native `click`, no `onClick`, no matter how well-formed the pointer events
are.

**Fix:** dispatch a third event of type `click` after the pair:
```js
canvas.dispatchEvent(mk('pointermove', x, y, 0))
canvas.dispatchEvent(mk('pointerdown', x, y, 1))
canvas.dispatchEvent(mk('pointerup',   x, y, 0))
canvas.dispatchEvent(mk('click',       x, y, 0))   // <- the one that matters
```
built in the page's MAIN world, with `offsetX`/`offsetY` forced via
`Object.defineProperty` (this browser derives `offsetX` as `clientX/2`), and
with frames forced (`pump()`) between them. Two related traps in the same
harness, both worth knowing:

- **sphere-shell's look-drag latches.** `MagicWindowControls`'s `pointerdown`
  handler sets its drag flag inside a `queueMicrotask` (deliberately - see its
  own long comment), which drains only after the whole synchronous console
  probe has finished. So a `pointerup` dispatched in the SAME probe arrives too
  early, the drag stays latched, and every later `pointermove` silently rotates
  the camera - which looks exactly like "my coordinates are wrong". Dispatch a
  `pointerup` on `window` at the START of each probe to clear it.
- **`setTimeout` is effectively frozen** in the permanently-hidden automation
  tab, so an `await`-a-timer loop never resolves. Anything that needs React to
  commit (a store write whose effect you then want to measure) has to be split
  across two separate tool calls instead.

## 6. A click needs a press SHORTER than 300 ms that starts and ends on the SAME object

The user, after a headset session: „Im VR lösen die Buttons nicht immer aus
oder nur sehr langsam, auch wenn sie durch das Zielen mit dem Controller schon
gehighlighted sind."

Two independent mechanisms in `@pmndrs/pointer-events@6.6.30`, both in
`dist/pointer.js`, produce exactly that. Neither is a uikit bug as such, but
uikit's structure is what makes the second one bite.

### 6a. The 300 ms budget

`Pointer.up` destructures its own defaults and hands them to `getIsClicked`:

```js
const { clickThesholdMs, contextMenuButton = 2, dblClickThresholdMs = 500,
        clickThresholdMs = clickThesholdMs ?? 300, } = this.options
const isClicked = getIsClicked(this.buttonsDownTime,
  this.intersection.object[buttonsDownTimeKey], nativeEvent.button,
  nativeEvent.timeStamp, clickThresholdMs)
...
if (!isClicked || nativeEvent.button === contextMenuButton) { return }
//click
emitPointerEvent(new PointerEvent('click', ...))
```

```js
if (buttonUpTime - objectButtonPressTime > clickThresholdMs) { return false }
```

**A press longer than 300 ms emits `pointerdown` and `pointerup` and no
`click`.** 300 ms is fine for a mouse. A VR press is aim, settle, squeeze,
release, and routinely exceeds it — the more carefully you aim at a small
target, the more likely the press is discarded. It is also why a quick stab
works when a deliberate press does not, i.e. "nur sehr langsam".

Note the misspelled `clickThesholdMs` is the deprecated alias; pass
`clickThresholdMs`.

**Fix:** `sphere-shell`'s `xrPointerOptions()` now sets
`clickThresholdMs: XR_CLICK_THRESHOLD_MS` (1500) on every pointer. The value
reaches the `Pointer` because `@react-three/xr` spreads each of those option
objects onto its default pointer component, which passes the whole prop bag
through `useRayPointer` to `createRayPointer(..., options)` — the same object
`Pointer` reads. Apps get it by spreading `xrPointerOptions()` into
`createXRStore`, which both apps here already did.

### 6b. Hover is ancestor-wide; a click needs one exact object, with zero slop

Same `getIsClicked`:

```js
if (objectButtonPressTime != pointerButtonsPressTime.get(button)) {
  //we have released the button somewhere else
  return false
}
```

The press timestamp is stamped onto the hit `Object3D`; the release reads it
back off whatever object is under the ray *then*. **There is no movement
tolerance anywhere in that file** — not a pixel, not a millimetre.

Meanwhile uikit gives one visual "button" many hit objects: `Component extends
Mesh` with its own `makeClippedCast` raycast, a lucide icon is an `Svg` that
builds **one mesh per subpath**, and `makeClippedCast` biases hit distance by
element type — so the icon, not the panel behind it, is usually what the ray
hits. A 22 px button containing a 14 px icon therefore has at least two hit
objects, and the dock's `...` button has three (one per dot).

Hover does not care: `pointerenter` is emitted on the hit object **and every
ancestor**, so the button lights up wherever inside it the ray lands. Hence the
exact symptom — lit, pressed, and nothing happened.

**Fix:** put `pointerEvents={DECORATIVE_POINTER_EVENTS}` (`'none'`, exported by
sphere-shell) on everything inside a control that exists to be looked at rather
than aimed at — icons, labels, thumbnails. `pointerEvents` is an *inherited*
uikit property, so one value covers a whole subtree (including an `Svg`'s
subpath meshes), and `'none'` excludes them from intersection outright rather
than merely ranking them lower. The control collapses back to one hit object.

Worth knowing: `e.stopPropagation()` is **not** an alternative. It stops
*ancestors* from receiving the event, never the target itself, so it does
nothing about which object the click is attributed to.

## 7. A `<Text>` only wraps when SOMETHING hands its measure function a width - an ancestor `maxWidth` is not automatically that something

**Symptom:** a `<Text>` inside a `Container` that has `maxWidth` (no explicit
`width`) renders as ONE overflowing/clipped line instead of wrapping, even
though `wordBreak` is left at its default (`'break-word'`, which does wrap).

**Found in:** the opencast player's `SubtitleHud.tsx` caption panel - a Quest
session report, „wenn die in dem Fenster länger als eine Zeile sind, die
nicht umbrechen".

**Root cause:** a uikit `<Text>`'s line-breaking comes from its own Yoga
measure function (`@pmndrs/uikit`'s `text/layout/measure.js`), which is only
called with a bounded `availableWidth` when Yoga's layout pass hands this
node a definite or `AtMost` width. It gets `undefined` - unbounded, so the
text measures one unbroken natural-width line - whenever nothing in the
ancestor chain hands it a width, which is exactly what happens when: the
`<Text>`'s parent `Container` has `maxWidth` but no `width` (so it
shrink-wraps to content, deliberately - a maxWidth-only Container does NOT
retroactively re-measure a wider-than-max child, it just clamps the
CONTAINER's own box afterward), AND that parent's `alignItems` is anything
other than the uikit flex column default of `stretch` (confirmed against this
project's own `DockTransport.tsx`: "a flex column's default `alignItems` is
`stretch`") - `center`/`flex-start`/`flex-end` let a child size itself
instead of handing it the parent's resolved width. Compare
`TranscriptWindow.tsx`'s row `<Text>`, which wraps with no `maxWidth` of its
own at all, because it sits under a `<Window size={...}>` whose
default-`stretch` `Container`s hand every descendant a definite width all the
way down to the leaf.

**Fix:** put `maxWidth` directly on the `<Text>` node itself, not (only) on an
ancestor `Container`. Yoga bounds a measure-function leaf's own available
width by ITS OWN `maxWidth` when sizing that leaf, independent of what (if
anything) its parent handed down - so the wrap now happens regardless of
`alignItems` or whether any ancestor establishes a definite width. See
`SubtitleHud.tsx`'s `CAPTION_TEXT_MAX_WIDTH` for a worked example (the
panel's content width, i.e. its own `maxWidth` minus its horizontal padding).
A shrink-wrapping ancestor `Container` (`maxWidth`, no `width`) still hugs
short text exactly as before - only the `<Text>`'s own bound changes.

## 8. A scrolling column's children default to `flexShrink: 1` - more siblings squashes EVERY row, not just the overflowing ones

**Symptom:** a `Container overflow="scroll"` column of many rows, each an
auto-height `<Container>` wrapping a `<Text>` - renders every row SHORTER
than its own content needs, and the shortfall grows with the sibling count:
the SAME row content measured 43.2px tall at 10 siblings, 27.9px at 20, 16.6px
at 30, and 12px (padding only - zero content height credited at all) at 40
and 50, live-measured via `Container.size.value` on the actual mounted rows.
Visually this is rows overlapping each other: the row BOXES (backgrounds,
click targets, the active-row highlight) shrink to fit however many exist,
but the TEXT inside each one still wants its full multi-line height, so it
bleeds into whichever neighbour is closest - „Die Zeilen im Transkript
überlagern sich".

**Found in:** the opencast player's `TranscriptWindow.tsx` - a Quest-adjacent
report („Die Zeilen im Transkript überlagern sich leider immer noch", after
an EARLIER round had already fixed a different overlap - the head-locked
`SubtitleHud.tsx` caption, entry 7's own bug - and this one turned out to be
a second, unrelated defect hiding behind a very similar-sounding complaint).
Confirmed live: 40 rows of realistic-length German sentences (mixed 1-line
and 2-3-line cues, from real oc.explore.opencast.org captions) - at the
UNFIXED code, `Container.size.value[1]` for every row converged toward the
padding floor as sibling count grew, uniformly across ALL rows regardless of
each row's own text length (ruling out "some individual row mismeasured its
own text" and pointing at a GLOBAL layout effect over the whole scrolling
column instead).

**Root cause:** since traced into `@pmndrs/uikit@1.0.75`'s own source: its
Yoga config runs `setUseWebDefaults(true)` (`dist/flex/yoga.js`), which makes
every flex child's `flexShrink` default to `1` (web semantics); uikit's own
commit-time guard (`dist/flex/node.js`) force-sets `flexShrink: 0` only for a
child with an EXPLICIT `height` prop inside a column - an auto-height row
falls through to shrinkable. Note the trigger is any column-direction parent
with auto-height children, scrolling or not; the scroll case is just where
the squash becomes visible as overlap. With N
auto-height children all shrinkable and a FIXED cross-axis box (the window's
own declared `size`), Yoga's flex-shrink resolution distributes the "not
enough room" deficit across every child proportionally to its own basis -
which is exactly "more siblings, less height each, uniformly" instead of
"content overflows its container and the container scrolls," which is what
`overflow="scroll"` is supposed to buy in the first place.

**Fix:** `flexShrink={0}` on every row `<Container>` in the scrolling column.
Verified live, same harness: with the prop in place, 50 rows of the SAME
mixed short/long content each report their own correct, content-driven
height (`43.2`/`27.6`, matching what a row reports in ISOLATION), and every
consecutive pair's `relativeCenter` gap matches `height/2 + gap + height/2`
to within measurement noise (checked across all 39 gaps in a 40-row mixed
run - zero deviations over `0.5px`) - i.e. no overlap, at a volume where the
unfixed code was already compressed to the padding floor. Applied
defensively to `MediaList.tsx`'s row `<Container>` too (backs the library,
series, and chapters lists - none of which happen to have enough real items
in this repo's own fixtures to have hit the threshold live, but the same
"long scrolling list of auto-height rows" shape is exactly this bug's
trigger).

**Relationship to entry 2 (cumulative wrapped-line volume can render
blank):** a DIFFERENT defect in the same neighbourhood, not the same one.
Entry 2 is about total WRAPPED-LINE volume in one column eventually making
the overflowing content's own glyph batch invisible; this entry is about
FLEX-SHRINK compressing every row's own LAYOUT BOX in proportion to sibling
COUNT, independent of how many lines any of them wrap to (a column of many
single-line, unwrapped rows shrinks under this bug too - wrapping is not a
precondition). `TranscriptWindow.tsx` still keeps its
`CONTINUATION_CHUNK_CHARS` split for entry 2's sake (an unusually long cue
still gets chunked into shorter rows, capping any ONE row's own wrapped-line
count) - the `flexShrink={0}` fix here is what keeps rows from overlapping
at realistic transcript LENGTHS (many rows), and is unrelated to how long
any single one of them is.

---

Linked from `src/App.tsx`'s header comment. Add an
entry here - don't just fix and move on - whenever a uikit rendering or
event-handling quirk costs more than a few minutes to diagnose.
