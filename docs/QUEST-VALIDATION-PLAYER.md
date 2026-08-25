# Quest 3 hardware validation checklist — Opencast player

This is the handover artifact for the Opencast player. It is the counterpart
to the `sphere-shell` library's own hardware validation checklist (see the
[sphere-shell repository](https://github.com/rrolf/sphere-shell)), which
covers the library and its demo. Everything below has been prepared:
build green, 652 unit tests green across the workspace, and the spec's whole
Definition of Done walked through on a desktop browser in magic-window mode
against the real `develop.opencast.org` — including a **real** two-flavor
recording, measured drift, master handover, chapter jumps, transcript, HUD
subtitles, dock scrubbing and every error path.

What is missing is a headset. The sandbox this was built in can reach no
WebXR session at all, so nothing below that says *in VR*, *through the
lenses*, *by ear* or *at 72 Hz* has ever run for real.

You do not need to read any `.superpowers/sdd/` task report to work through
this — everything relevant is summarized here. Report back using the
[last section](#6-what-to-report-back).

## 1. Start the dev server so the Quest can reach it

From the repo root:

```bash
npx pnpm@10.4.1 dev
```

(if `pnpm` is on your PATH, drop the `npx pnpm@10.4.1` prefix and just run
`pnpm dev`.)

That serves **HTTPS on port 5190, bound to all interfaces** — both required
for a Quest browser to open a WebXR session against a dev server on your LAN.

**First run asks for your password.** The config uses `vite-plugin-mkcert`
(WebXR needs a secure context), and mkcert installs its root CA into the
system keychain. Answer once; it will not ask again.

Vite prints a "Local" and a "Network" URL. Three routes to the headset, in
increasing order of certificate hassle avoided:

**Route A — LAN URL.** Open the **Network** URL (`https://192.168.x.x:5190`)
in the Quest browser; headset and machine must be on the same Wi-Fi (not a
guest/isolated network — many routers block device-to-device traffic there).
The first load shows a certificate warning, because the mkcert CA is trusted
on your machine and not on the headset. Proceed past it ("Advanced" →
"proceed to site"). This is what worked for the demo.

**Route B — USB, HTTPS.** With the headset in developer mode and plugged in:

```bash
adb reverse tcp:5190 tcp:5190     # then open https://localhost:5190 on the Quest
```

Same certificate warning, no LAN or firewall involvement. The forward has to
be re-established after every `adb` restart (`adb reverse --list` shows what
is currently forwarded).

**Route C — USB, plain HTTP, no certificates at all.** `localhost` is a
[trustworthy origin](https://w3c.github.io/webappsec-secure-contexts/) in its
own right, so a port forwarded over USB is a secure context *without* TLS —
"VR betreten" works and there is nothing to accept. The player's tracked
config is HTTPS-only, so this needs a small config file of your own. Create
`vite.local-http.config.mts` (this project's convention
is to keep such helper configs out of version control — it will show up as an
untracked file in `git status`, and deleting it costs nothing):

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],                                  // no mkcert -> plain HTTP
  server: { host: true, port: 5192, strictPort: true },
})
```

then

```bash
npx vite --config vite.local-http.config.mts
adb reverse tcp:5192 tcp:5192     # then open http://localhost:5192 on the Quest
```

**If "VR betreten" does not appear at all**, the flat page's top-left overlay
says why in one line — `secureContext=false` (the certificate route did not
produce a secure context; use Route C), `navigator.xr missing` (wrong
browser), or "no immersive-vr device". That status line is there precisely so
"cannot start a session" and "still probing" are never confused.

### Optional: reading numbers off the headset

Every measurement in this document's desktop counterpart came from a
verification handle the app publishes on `window`. It works on the Quest too,
via `chrome://inspect` from a desktop browser over the Route B/C USB setup:

```js
__opencastPlayer.sample()   // master, play state, and per-stream currentTime/muted/paused/readyState
```

Two `currentTime` values from one `sample()` differ by exactly the drift
between those streams. That is the honest way to answer "are they really in
sync" if your eyes are not sure.

## 2. Optional: point the player at your own Opencast server

The server URL is **code-only** — there is no UI field and no environment
variable (deliberate: v1 targets one public server; a configurable UI belongs
with the auth work that comes later). The client is constructed with no
options, so it falls back to `DEFAULT_BASE_URL` in
`src/opencast/client.ts`. This is the line as it stands,
in `src/App.tsx`:

```ts
const client = useMemo(
  () => (import.meta.env.DEV ? new SyntheticDualStreamClient() : new OpencastClient()),
  [],
)
```

Change it to pass a `baseUrl` to both constructors — the whole edit is the
added `options`:

```ts
const client = useMemo(
  () => {
    const options = { baseUrl: 'https://opencast.example.org' }   // <- added
    return import.meta.env.DEV ? new SyntheticDualStreamClient(options) : new OpencastClient(options)
  },
  [],
)
```

Vite's HMR picks that up without a restart. The same options object takes the
two auth seams the data layer was built with — `authorize(init, url)` to shape
every request (the JWT/LTI hook) and `resolveAssetUrl(url)` to rewrite media
and image URLs (signed URLs). Neither is wired to anything in v1.

Your server must send permissive CORS headers for anonymous browsing to work
at all; `develop.opencast.org` does.

**You probably do not need another server.** `develop.opencast.org` now
carries a genuinely two-flavor recording — **"Dual-Stream Demo"**, under
*Einzelaufzeichnungen* — with a presenter camera (720p), a 1080p screen
recording and English captions. That is the recording to use for most of the
checklist below. (It also means the "Zweiter Stream (Test)" checkbox, which
fakes a second stream by duplicating the only one, is no longer needed for
multi-stream checks — leave it off.)

## 3. The Definition of Done, as checks

Every row here was verified on the desktop except where it says otherwise, so
a failure on the headset is a genuine finding, not an untested path. Run them
**inside a session** unless a row says to do it on the flat page.

Before entering VR: the dev-only checkboxes in the flat page's top-left
overlay ("Zweiter Stream (Test)", "Kapitel (Test)") are DOM overlay controls
and therefore **invisible inside a session** — tick what you need first. Both
take effect on the *next* episode you open.

### Browse

- [ ] **Series and single recordings** — the "Bibliothek" window lists the
      server's series, plus an **"Einzelaufzeichnungen"** group tile at the
      end for recordings that belong to no series. Both levels show
      thumbnails; episode tiles show duration and date.
- [ ] **Pagination** — open "Einzelaufzeichnungen": you should get a page of
      tiles plus a **"Mehr laden"** button, and pressing it should append the
      rest and then remove the button. (12 per page.)
- [ ] **A recording with nothing playable is marked, not broken** — if your
      server has an episode with no downloadable video track, its tile reads
      "… - nicht abspielbar" and clicking it does nothing (no empty player).
      `develop.opencast.org` has no such episode, so this one was verified
      with a constructed stub; skip it unless your own server has one.

### The player

- [ ] **Open "Dual-Stream Demo": the video, and nothing else** — you should
      get two video windows, "presenter" and "presentation", side by side at
      **±27° and 52° wide each** (they were 40° at ±24° before this round), plus
      the dock. "Kapitel", "Transkript", "Reihe" and "Info" must NOT be on the
      shell: each is a **closed tile in the dock**, one click from coming back.
      This is the round's headline change — judge whether the pair now fills the
      view comfortably or overshoots it, and whether the tiles read as "your
      panels are here" rather than as "something went wrong".
- [ ] **A single-stream recording goes wider still** — open "Was ist Chaos?".
      One window, centred, **64° wide**. Same question: too big, about right, or
      still room to grow?
- [ ] **The panels come back the way you expect** — click each dock tile; the
      window returns where it was. Then click the **last breadcrumb crumb** (the
      recording's own name, now carrying a list icon): the "Reihe" window opens,
      and clicking the crumb again closes it. Same for the dock's **ⓘ** button
      and the "Info" window. Both must feel like the same gesture as the tile,
      not like a different mechanism.
- [ ] **They play in sync** — press ▶ in the dock. Watch a slide change
      against the presenter's speech for a minute or two. Desktop measurement
      on this exact recording: **max drift 0.034 s over 14 s** (budget: 0.1 s),
      with no corrective seek needed. If you see lip-sync-scale drift
      (> ~0.1 s) or one window freezing while the other runs, that is a real
      finding — `__opencastPlayer.sample()` gives you the number.
- [ ] **Audio comes from exactly one window** — the "master" stream is
      unmuted, every other stream is muted. Two voices at once would be a bug.
- [ ] **Chapter jumps** — tick "Kapitel (Test)" on the flat page and reopen
      an episode (`develop.opencast.org` publishes no slide segments, so the
      three test chapters at 0:00/1:00/2:00 are the only way to exercise
      this). A "Kapitel" **tile** appears in the dock - like the other panels it
      now starts closed; click it to open the window. Clicking a chapter must
      seek **both** streams to that mark, and must **not** start playback by
      itself.
- [ ] **The transcript follows, and clicking it seeks** — "Dual-Stream Demo"
      and "Was ist Chaos?" have real captions. The cue at the current
      position is highlighted and moves along as it plays; clicking any cue
      jumps there. Also confirm the list **scrolls** with whatever scroll
      input the Quest browser gives a uikit scroll container ("Was ist
      Chaos?" has 29 cues, well past the fold) — scrolling by real controller
      or hand input has never been observed working in this project.
- [ ] **HUD subtitles toggle** — the **CC** button in the dock's first row
      (it moved there from the old "Steuerung" window in the UX round). With
      it on, the current caption should ride in front of you as a head-locked
      panel.
- [ ] **HUD subtitles stay readable at any head angle** — *the substance of
      this row is hardware-only.* Look up, down, hard left and right, and
      move your head quickly. The panel lazily follows your gaze (it lags on
      purpose, then settles), must stay legible and must not clip, jitter, or
      swim. See section 4 for the specific worry.
- [ ] **Caption SIZE: is `M` right in a headset?** — *this is the row most
      likely to produce a real finding.* The `Aa S/M/L` button in the dock
      cycles the caption size. The default (`M`) and the whole ladder were
      **retuned browser-first**, because the previous size did not fit a
      browser window at all: the three steps put the caption panel at
      0.9 / 1.1 / 1.5–1.7 m wide, i.e. 44 / 53–60 / 71–80 % of the canvas
      width in a 4:3 magic window. A headset renders each eye through its own
      narrower, lens-corrected frustum, so **these may well read as too
      SMALL through the lenses.** Please report, per step: legible without
      leaning in? and does `L` still fit inside a comfortable field of view
      without head-turning to read one line? If `M` is too small, the fix is
      one constant — `SUBTITLE_SCALE_STEPS` in
      `src/windows/subtitleHudState.ts`.
- [ ] **The caption backdrop only *dims* the picture** — with a caption over
      a bright part of the video, you must still see the picture through the
      panel. It is a 40 %-opacity black wash, not a solid slab (desktop
      measurement: video pixels at ~(235,238,229) read ~(140,142,137) through
      it — a 0.60 factor on every channel). If it reads as an opaque black bar
      through the lenses, that is a finding.
- [ ] **The caption is not in the way of anything** — aim the controller ray
      *through* the caption panel at a control behind it (a dock button, a
      window) and click. The click must land on the thing behind; the caption
      must never intercept it, and must never highlight or react. Verified on
      the desktop by clicking the dock's ▶ straight through the panel, but the
      controller ray is its own code path.
- [ ] **A recording without captions offers neither** — open "Coffee Run" or
      "Weitsprung": no "Transkript" window at all, the dock's **CC** and
      `Aa` buttons greyed and inert, and "Keine Untertitel für diese
      Aufzeichnung verfügbar." in the "Info" window.
- [ ] **Mute and volume in the dock** — the 🔊 button silences the session;
      the picture must keep running (mute is not pause). Unmuting must come
      back at the same loudness, not at full volume. Then step `−`/`+`
      through a few 10 % steps and confirm the loudness actually tracks the
      percentage, including while muted (step it down while muted, unmute,
      and it should come back quieter). Both moved here from the old
      "Steuerung" window.
- [ ] **Breadcrumb reachability with the controller ray** — the dock's second
      row is small text (11 px at the dock's own pixel scale). Aim at each
      crumb in turn: `Home`, the series name, the current recording. Are they
      big enough to hit reliably at the dock's distance and −30° elevation, or
      does the row need to be taller in a headset? `Home` must return to the
      library's top level; the series crumb must open the library **already
      showing that series' recordings** (not the top level); the current
      recording's crumb must do nothing at all.
- [ ] **Previous/next recording, from the dock** — open "Was ist Chaos?"
      (series *AV-Portal Content*, two episodes), start playback, then press
      ⏮. "Weitsprung" must load at 0:00 and **stay paused** — playback only
      ever starts on a deliberate press of ▶. At the ends of the series the
      corresponding button is greyed and inert; for a series-less recording
      (e.g. "Video Of A Tabby Cat") both buttons are absent, as is the series
      crumb.
- [ ] **Episode switch inside the series, from the "Reihe" window** — the
      same check from the other direction: click the other episode in the
      "Reihe" window. Same rule, new recording at 0:00, still paused.
- [ ] **The two-row dock still looks and feels like one strip** — one large
      Play/Pause square spanning both rows, the timeline alone across row 1,
      everything else in row 2, and the shell's own two square buttons (the
      `...` menu and, in a session, the red X) at the right-hand end. Confirm it
      does not collide with the video windows, that the shell's own buttons
      still read as a separate group, and that nothing is cut off at the edges.
- [ ] **The timeline is worth aiming at now** — it runs the full width of the
      dock's control block (measured in the browser: 933 px of a 1566 px strip,
      versus a 180 px stub before). Scrub it with the controller ray: the
      question is whether a whole lecture's worth of resolution is genuinely
      reachable, or whether the ends are awkward at this width.
- [ ] **Caption size, in − / + steps** — with captions on, the dock shows
      `Aa − 100% +`. Each press is 12 % of the current size. **The default is
      new and deliberately smaller than the old "S"** — the first headset
      session reported „L ist zu groß … S ist gefühlt auch noch ein wenig zu
      groß". Is 100 % right through the lenses now? If not, note the percentage
      you settle on: that number is one constant (`DEFAULT_CAPTION_SCALE`).
      There are five presses of headroom below the default and about seven
      above it.
- [ ] **Caption position, in ▲ / ▼ steps** — 3° of pitch a press, ±12°. Check
      that the range is enough to clear whatever the video has burned into its
      own bottom edge, and that the bottom of the range does not bury the
      caption in the dock.
- [ ] **The four caption buttons appear only with captions ON** — press CC
      off: `Aa − % + ▲ ▼` must all disappear (the dock gets narrower), and come
      back together when you press CC again.
- [ ] **Caption size and position survive a restart** — set them, leave the
      session, reload the page, open a recording again. Both must come back.
- [ ] **The shell's `...` menu** — press the three-dot button at the right of
      the dock. A small panel opens above the strip with Arrange, Recenter and
      Curved. Each acts and closes the menu; pressing `...` again closes it
      without acting. Judge whether a menu is better here than the three
      permanent buttons it replaced, and whether the panel opens somewhere your
      hand naturally goes.
- [ ] **Exit VR is a red X with a hover label** — the way out of the session is
      now an unlabelled red square. Rest the controller ray on it: an "Exit VR"
      label appears above it. The real question is whether an icon-only exit is
      findable at all in a headset — if it is not, that is a finding worth more
      than the width it saved.
- [ ] **Closing a video window really unloads it** — press a video window's
      ✕. Its picture goes, a tile appears in the dock, and nothing keeps
      downloading or decoding in the background. (Worth watching the headset
      for heat/battery over a few minutes with one of two streams closed.)
- [ ] **Closing the MASTER hands over the sound seamlessly** — *judge this by
      ear.* With both streams playing, close the window whose audio you are
      hearing (the left/"presenter" one by default). The remaining window must
      take over the sound with no silence, no double audio and no hitch, and
      keep playing from where it was.
- [ ] **Restoring from the dock tile rejoins in sync** — click the dock tile
      of the window you just closed. It comes back at its old position and
      size and re-enters the shared clock. Desktop measurement: **−0.044 s**
      offset immediately after the restore, and the audio moves back to it
      (it is the preferred master).
- [ ] **The last remaining video window refuses to close** — press ✕ on the
      only open stream: nothing happens (a player with no video is not a
      state this app allows). The button looks pressable but is inert; see
      section 4.
- [ ] **Dock timeline seek, with HUD feedback** — drag the thin bar in the
      dock. While dragging, a head-locked panel shows the target time and,
      when the recording has chapters, the chapter there ("0:30 - Kapitel 1
      (Test)"). Playback jumps only on release. Please check specifically:
      does the ray-based drag *feel* right with a controller — does the fill
      track where you are actually pointing, all the way to both ends?
- [ ] **Everything above with hand tracking too** — put the controllers down
      and repeat a representative handful (a tile click, the subtitle toggle,
      a timeline drag, a window ✕ and a dock-tile restore). Pinch-driven
      pointer input shares all its code with the controller ray, but no
      automated environment here could raycast either one.

### Controller bindings (new this round — none of it has ever run on hardware)

Nothing here could be tested anywhere but on your head: no automated
environment in this project can produce an XR session, let alone a gamepad. The
decision logic behind each row is unit-tested, so what is genuinely open is how
it *feels* — please answer the "does it feel right" question in each row, not
only pass/fail.

- [ ] **⚠️ First, the one to veto: recentering is on B, and it is a HOLD.**
      You asked for „Taste B dann zum Neuzentrieren". It is on B — but you have
      to hold it for about a second, which is the behaviour A had before. That
      was kept deliberately rather than made a plain press: recentering throws
      the entire shell to a new position and yaw, it is the one action with no
      undo, and B sits under the same thumb that is now pressing A for
      play/pause all the time. A brushed B that instantly reoriented the world
      would be the worst thing this app can do to you.
      **Try it, then say whether you want it as a plain press instead** — that
      is a one-word change (`recenterButton` keeps the hold; a bare press means
      binding your own control). If the hold feels right, say so too.
- [ ] **A and X both play/pause** — press A on the right controller, then X on
      the left. Each should toggle exactly once per press, from either hand,
      and the dock's big ▶/⏸ button should change with it. Specifically check
      it does **not** re-toggle while you keep the button held down.
- [ ] **Left stick, left/right, seeks — and the speed follows the stick.**
      Push the left stick a little: the position should creep (about 2 s of
      video per second of holding). Push it to the stop: about 30 s/s. The
      curve is deliberately slow at the bottom so small corrections („I missed
      that sentence") are precise.
      **Two things to judge:** is the gentle end fine enough, and is 30 s/s
      fast enough at the stop? Both are single constants
      (`SEEK_MIN_RATE`/`SEEK_MAX_RATE` in `player/xrPlayerInput.ts`) and easy to
      retune, so a number you would prefer is more useful than pass/fail.
- [ ] **The stick scrub PREVIEWS, and only seeks when you let go.** While you
      hold the stick, the head-locked panel and the dock's time readout and fill
      bar should track a moving target while the picture keeps playing (or stays
      paused) where it was; the jump happens on release. This is the same
      preview-then-commit behaviour as dragging the timeline, on purpose —
      seeking a video every frame never finishes one seek before starting the
      next and would stall both streams. If the picture instead stutters or
      freezes *while* you hold the stick, that is a real finding.
- [ ] **Left stick up/down jumps a chapter — once per flick.** Tick „Kapitel
      (Test)" on the flat page first, then open a recording. A firm push down
      should jump to the next chapter and **stop there** even if you keep
      holding it; coming back to centre re-arms it. Up goes to the previous
      chapter (the order the „Kapitel" window lists them in — earliest at the
      top). Check both: that a held stick does not page through chapters, and
      that a vague half-push does nothing at all.
      Say if you would rather have up/down the other way round.
- [ ] **The two axes do not fight each other.** Scrub left/right for a few
      seconds, then flick up or down without releasing. The chapter jump should
      win and the scrub should be abandoned, not commit its own seek afterwards
      and undo the chapter you just landed on.
- [ ] **Right stick still moves and turns you, and B is the only shell binding
      left.** The library reads nothing else: no left stick, no other button.
      Confirm the right-stick dolly and smooth rotation are unchanged, and that
      A no longer recenters.
- [ ] **Nothing drifts when you let go.** Rest both thumbs on the sticks
      without pushing and watch for a minute. The playhead must not creep and
      no chapter must fire — stick drift is what the deadzones are for.

### Button responsiveness — please re-rate this specifically

You reported: „Im VR lösen die Buttons nicht immer aus oder nur sehr langsam,
auch wenn sie durch das Zielen mit dem Controller schon gehighlighted sind."
Two causes were found in `@pmndrs/pointer-events` and both are fixed. This is
the highest-value row in the round, because the diagnosis is certain but the
*cure* is only as good as your hands say it is.

What was wrong, in one line each:

1. **Any press longer than 300 ms was silently thrown away.** The library
   emitted the press and the release and simply did not count it as a click.
   The threshold is now 1500 ms.
2. **A button was several hit targets, not one.** A click required the release
   to land on the *exact* same object as the press, with zero tolerance, and a
   button's icon is a different object from the button — while the *highlight*
   covers the whole button either way. That is exactly why it lit up and then
   did nothing. Icons, labels and thumbnails no longer take hits at all.

- [ ] **Rate it against last time: better / the same / worse.** A plain
      "roughly the same as before" is a genuinely important answer here — it
      would mean the real cause is something neither of these, and worth
      knowing before more is changed.
- [ ] **Press deliberately, not quickly.** Aim at the dock's ▶, settle, and
      press the way you naturally would rather than stabbing. That press used
      to be discarded. It should now work every time.
- [ ] **Aim at the ICON, not the edge of the button.** Put the ray right on the
      glyph of a small dock button (the captions ⊞/⊟, a volume +/−) and press.
      That was the case most likely to fail before.
- [ ] **The small stuff:** the caption size +/−, the caption up/down arrows,
      the ⓘ button, the ✕ and – on a window title bar, a dock tile, a chapter
      tile, a transcript row. Anything that still needs two attempts is a
      finding — please say *which* control and whether it highlighted first.
- [ ] **Cancelling still works.** Press and hold on a window's ✕, aim away
      while still holding, then release. Nothing should close. (This is the
      property that was deliberately NOT traded away — firing on press instead
      would have "fixed" the responsiveness by removing it.)
- [ ] **Hand tracking too.** A pinch is slower than a trigger squeeze, so it
      was hit harder by the 300 ms limit than the controllers were. If hand
      tracking felt worse than controllers before, it is worth checking whether
      that gap has closed.

### Performance gate

- [ ] **Stable 72 Hz with two 1080p streams.** The spec's hard number.

"Dual-Stream Demo" is 1080p + 720p. For a true two-times-1080p load, tick
"Zweiter Stream (Test)" before opening a recording whose best rendition is
1080p — that duplicates it, so both windows decode the same 1080p stream on
independent decoders. ("View of Planet Earth (4K)" under *Wiki Commons
Content* is a deliberately harsh variant of the same test.)

**How to check:** the Quest browser's performance HUD (Meta Quest developer
settings → "Performance HUD"), or read
`xrStore.getState().session?.frameRate` from a devtools console attached over
`chrome://inspect`.

**If it misses 72 Hz**, in this order, recording the frame rate at each step:

1. Foveated rendering — `createXRStore({ foveation: 1 })` in
   `src/xrStore.ts`.
2. Close the "Transkript" window while measuring (a long uikit scroll column
   is the most glyph-heavy thing on screen).
3. Shrink the dock's preview render targets — `PREVIEW_WIDTH`/`PREVIEW_HEIGHT`
   (256/144) in the `sphere-shell` library's
   `src/components/previewCapture.ts` (a separate package — this needs a
   local checkout of `sphere-shell`, an edit there, and a rebuild/republish
   or a local link) —
   and rebuild.

The bounded draw-order/mesh-count cost documented in the `sphere-shell`
library's own hardware validation checklist §4 applies here unchanged: focus
changes grow the mesh count to a ceiling and then stop. A frame rate that
*degrades over time* as you click between windows would be new information.

## 4. Items specifically flagged as unverified in the sandbox

These are the ones most worth your attention, because no desktop check could
settle them.

- **`<HeadLocked>` keystone and shear through the lenses.** The subtitle and
  seek-feedback panels are the project's first head-locked UI. On a desktop
  canvas they render flat and correct, but a head-locked panel is drawn at a
  fixed offset from the head pose, and each eye's view axis differs slightly
  from the head's — so a panel that looks rectangular on a monitor can show
  keystone (trapezoid) or shear in stereo, and can read differently in the
  two eyes. Look at a long caption line straight on, then with your head
  turned well off-axis. If it looks skewed, or *different* between eyes,
  please say so in detail — that is the one finding that would send the HUD
  back to the drawing board (and it gates publishing `sphere-shell` 0.3.0).
- **Both HUD panels at once.** Subtitles on *and* a timeline drag in
  progress: the caption panel and the seek-feedback panel are stacked in one
  head-locked container, and on the desktop the pair sits partly off-frame,
  so their spacing has never actually been seen. Do they overlap? Does one
  push the other out of view?
- **Curved mode's timeline scrubbing is knowingly imprecise.** With "Curved" on
  (the dock's `...` menu), timeline drags land up to about **6.4 % off** near the
  panel's edges (the bend is a vertex-shader effect the pointer maths does not
  know about). Clamping and monotonicity still hold, and **flat mode — the
  default — is unaffected**. This is documented and deferred, not a
  regression: the proper fix needs a new `sphere-shell` API. Please report how
  wrong it *feels* rather than treating it as a bug to be found; if it is
  unusable, that raises the priority of the library work.
- **What happens AFTER a stream fails.** The error tile itself was exercised on
  the desktop for every case spec §9 lists; the recovery *from* it is the one
  path no hardware run has seen, and it is worth two minutes because the
  aftermath is where this app used to wedge itself. Provoke it the crude way:
  start a two-stream recording playing, turn the headset's Wi-Fi off for a few
  seconds, turn it back on. The failing window should swap its picture for a
  red tile naming the cause, with a "Neu laden" button, and everything should
  pause. Then check, in this order:
  1. **▶ works, first press.** The dock button must show ▶ (not ⏸), and one
     press must restart the streams that are still fine — no dead click, no
     spinner that never stops.
  2. **"Neu laden" brings the failed stream back**, in sync with the others and
     with the audio arrangement intact. If the stream that failed was the one
     you were *hearing*, the sound should have moved to another window when it
     failed, and may move back on reload.
  3. **On a single-flavor recording** (most of them), the tile also prints a
     line pointing at the dock's **"Home"** crumb — because that window's ✕ is
     inert (see below) and a permanently dead URL has no other way out. Confirm
     the line is there, that it names "Home" (it used to say "Bibliothek",
     which no longer exists), and that Home really does get you back.
  A wedged spinner, a ▶ that needs two presses, or a reload that comes back out
  of sync are all real findings here.
- **Minimized streams keep decoding.** Minimizing a video window drops its
  texture but not its playback (that is deliberate — it stays on the shared
  clock, ready to come back in sync). With two streams that means full decode
  cost for a window you cannot see. Watch for heat and frame rate.
- **The last stream's ✕ is an inert button.** `sphere-shell` 0.3.0 has no
  `closable` prop, so the veto happens *after* the shell has already closed
  the window: it is closed and immediately restored, which costs one
  unmount/remount frame and silently moves focus. On a headset that might
  read as a visible flicker. Say if it does.
- **Real controller and hand-tracking input end to end.** Mouse and touch
  drove every check in the sandbox. The dock timeline drag is the most
  demanding case (a captured pointer whose ray is re-evaluated every frame).
- **Every controller BINDING, without exception.** The left-stick seek, the
  chapter flick, A/X play/pause and B-to-recenter have never run against a real
  gamepad — no automated environment in this project can open an XR session, so
  the decision logic is unit-tested against synthetic axis values and the
  component that feeds it real ones is verified only by reading. The thresholds
  most likely to be wrong on hardware are the seek deadzone (0.2) and the
  flick's fire/re-arm pair (0.8 / 0.35): too low and a resting thumb triggers
  them, too high and the gesture feels stiff.
- **Whether the button-responsiveness fix actually worked.** The two causes
  were read directly out of `@pmndrs/pointer-events`' source and are certain;
  that they were *the* causes of what you experienced is an inference. See the
  "Button responsiveness" section.
- **Continuous long playback.** The sandbox browser throttles hidden tabs, so
  dual-stream playback was only ever observed in bursts of tens of seconds.
  Two 1080p streams for ten uninterrupted minutes is genuinely new territory.
- **Comfort while moving.** Right-thumbstick dolly and smooth rotation come
  from the library and were validated with the demo's windows — but not with
  a video wall plus a head-locked caption panel in front of you. Does the HUD
  make turning uncomfortable?
- **Passthrough.** The player has no background switch (unlike the demo) and
  always enters `immersive-vr`, i.e. black. If you want to see the windows
  over your real room, that is a feature request, not a bug — but do say
  whether you want it.

## 5. Known cosmetic limits (no need to hunt for them)

- Six or more video flavors overlap by about one degree of azimuth. No real
  recording has that many.
- Long caption lines are hard-wrapped at a fixed character count, which can
  land mid-word.
- Non-playable episode tiles still light up on hover, even though clicking
  them does nothing.

## 6. What to report back

Pass/fail per row plus a note on each fail is enough. Especially useful:

- **Whether button responsiveness actually improved**, and by how much. See
  that section — "about the same as before" is as valuable an answer as "fixed".
- **Whether B-to-recenter should stay a hold or become a plain press.** The
  only row here that is a decision rather than a check.
- **The two seek rates**, if 2 s/s and 30 s/s are not the numbers you want, and
  whether the chapter flick's up/down directions are the right way round.

- **The HUD**, in as much detail as you can bear: legibility, keystone/shear,
  whether the two eyes agree, how the lazy follow feels when you turn
  quickly, and what happens when a caption and a seek preview show at once.
- **The master-close handover, by ear** — any gap, doubling or hitch.
- **The actual Hz** with two 1080p streams, and which mitigation (if any) was
  needed.
- **How the dock timeline drag feels** with a controller ray, flat and (if
  you try it) curved.
- **Controllers vs hand tracking**: which interactions worked with each, and
  anything that felt hard to hit — the dock's transport controls are the
  smallest targets in the app.
- Whether two streams stayed in sync over several minutes, and the numbers
  from `__opencastPlayer.sample()` if you got them.
- Anything that crashed, froze or looked visually broken. The Quest's own
  screen recording is very helpful here.
