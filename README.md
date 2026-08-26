# `opencast-player`

A WebXR player for [Opencast](https://opencast.org/) lecture recordings, built
on [`sphere-shell`](https://github.com/rrolf/sphere-shell) (npm: `sphere-shell`).

Every video track of a recording becomes its own window on the sphere around
you — presenter camera, screen recording, whatever else the recording carries —
kept on one shared clock, with chapters, a running transcript, head-locked
subtitles, series navigation and a transport in the dock. The same code renders
immersively on a Quest 3 and as a magic window in an ordinary browser.

Anonymous and read-only against a public Opencast server's Search API. No
login, no HLS, no quizzes — see [Scope](#scope-and-non-goals).

## Run it

`npx pnpm@10.4.1` works in place of `pnpm` if pnpm is not on your PATH:

```bash
pnpm install
pnpm dev     # HTTPS on all interfaces, port 5190
pnpm test    # unit tests
pnpm build
```

**First run of `dev` asks for your password.** WebXR requires a secure
context, so the dev server speaks HTTPS via `vite-plugin-mkcert`, which
installs its root CA into the system keychain. Answer once; it will not ask
again.

Then open the printed URL. On a desktop you get the magic window (mouse-drag
to look, `R` to recenter); the top-left overlay has the "VR betreten" button
when a headset is present, and otherwise says in one line *why* WebXR is
unavailable. For a headset, see
[`docs/QUEST-VALIDATION-PLAYER.md`](docs/QUEST-VALIDATION-PLAYER.md),
which covers the LAN and `adb reverse` routes and the whole acceptance
checklist.

For a production deployment as a static site (nginx, TLS, SELinux, firewalld,
on Rocky Linux 10), see
[`docs/INSTALL-rocky-linux-10.md`](docs/INSTALL-rocky-linux-10.md).

## Controls

Everything you operate while watching is in the **dock**, the strip below the
windows — one place, always in reach, always aimable with a controller ray. In
player mode it is one large Play/Pause square spanning two rows, and beside it
two rows of everything else (browse mode shows no transport at all):

| Row | Control | What it does |
|---|---|---|
| both | ▶ / ⏸ | Play/pause, as a 60 px square spanning both rows — the biggest target in the strip, because it is the one control you reach for without looking. A spinner glyph replaces it while the wall is buffering. |
| 1 | `0:32` timeline `2:42` | The timeline, and nothing else, across the whole width of the dock's control block. Click or drag to seek; the target time (and the chapter there, if the recording has segments) previews in the HUD while you drag. The position and duration readouts flank it, where they have always been. |
| 2 | `Home > Reihe > Aufzeichnung` | Where you are. **Home** goes back to the library; **Reihe** opens the library already showing that series' recordings; **the current recording's crumb opens the Reihe window** (and closes it again) — it carries a list icon to say so. The series crumb, and the icon, are absent for a recording with no series. |
| 2 | ⏮ ⏭ | Previous/next recording of the series, in the series' own order, skipping ones with nothing to play. Disabled at either end, absent for a series-less recording. Switching **never autoplays** — the next lecture lands paused at 0. |
| 2 | CC | Subtitles on/off. Greyed out for a recording with no captions. |
| 2 | `Aa` `−` `100%` `+` | Caption **size**, in 12 % steps of the current size. **Only while captions are on.** |
| 2 | ▲ ▼ | Moves the caption up or down, 3° of pitch a press, ±12°. **Only while captions are on.** |
| 2 | 🔊 / 🔇 | Mute the session. Keeps the volume level — unmuting comes back to exactly where you were. |
| 2 | `−` `100%` `+` | Master volume in 10 % steps. Only the master stream carries audio; see the sync engine. |
| 2 | ⓘ | Opens (and closes) the **Info** window. |

To the right of the app's own controls sit sphere-shell's two: a **`...` menu**
holding Arrange, Recenter and the experimental Curved/Flat toggle, and — only
inside a session — a red **X** that ends it (hover it for an "Exit VR" label).

**The timeline takes its width by construction, not by a constant.** The column
of two rows sizes itself to its widest child, which is always row 2; row 1
stretches to that width; and only the track grows into what row 1 has left over.
So it re-solves itself when the caption buttons appear, when the breadcrumb
changes, or when a recording has no series.

### What is on screen when a recording opens

**Only the video windows**, and as large as the comfortable field of view
allows: one stream gets 64° of azimuth centred straight ahead, a pair gets 52°
each at ±27°. Both are derived from a usable arc of about ±55° (a Quest 3 sees
roughly 110° at once) and from the dock's own −30° elevation, not chosen by eye.
A third stream and beyond keeps the earlier layout: 40° mains, 24° flanks.

**Kapitel, Transkript, Reihe and Info start closed**, each as a dock tile — the
same closed-window tile the shell already uses, so getting one back is the
click you already know. The Reihe window also opens from the breadcrumb's last
crumb and Info from the dock's ⓘ. Opening a *different* recording from within
player mode leaves whatever you arranged alone; the panels only start closed
when you enter player mode from the library.

### Caption size and position

**Caption size defaults small on purpose.** uikit's pixel-to-meter conversion
is fixed at 0.01 m/px, which makes the caption panel's raw design size about
5.6 m wide hanging 1.2 m from your eyes — inside a magic-window frustum only
about 2.7 m wide. The scale runs 0.09 to 0.32 with 0.16 the default; the ladder
is **multiplicative** (12 % of the current size per press), because a fixed
increment is a 22 % jump at the small end and a 6 % nudge at the large one. The
readout is a percentage of the default, so "100 %" is where everyone starts.

The mechanism is one factor multiplied into the caption panel's own design
pixels — font size, padding, corner radius and max width together, which is a
uniform scale rather than a reflow, and keeps uikit's SDF glyphs crisp at any
factor. Only the caption scales; the seek-feedback readout it shares the HUD
with stays a fixed size.

▲/▼ move the whole head-locked HUD's resting pitch, ±12° around its default of
15° below your gaze — far enough to get the captions off a subtitle burned into
the video, not far enough to put them on the video's middle or down in the dock.

Both settings **persist across reloads** (one `localStorage` key,
`opencastxr.player.caption`). They are accessibility settings: a control that
has to be re-found on every visit gets pressed once and then endured. A storage
that is missing, full, or forbidden is not an error — the setting simply applies
for this session only.

The defaults were retuned after the first headset session ("L ist zu groß … S
ist gefühlt auch noch ein wenig zu groß"): the default is now below what used to
be the smallest step, with five more presses available underneath it.

### Dev-only test aids


The flat page's top-left overlay carries two checkboxes that exist **only in a
dev build** (`import.meta.env.DEV`; a production build drops them and the code
behind them entirely), because `develop.opencast.org` cannot exercise
everything the player does:

| Checkbox | What it does | Why |
|---|---|---|
| **Zweiter Stream (Test)** | Duplicates the next opened recording's only video track under a second flavor | Most recordings there have a single video flavor, so nothing would exercise the sync engine. Rarely needed now: that server has since gained a genuine two-flavor recording, "Dual-Stream Demo". |
| **Kapitel (Test)** | Adds three chapter marks (0:00/1:00/2:00) to the next opened recording | No recording on that server publishes slide segments, so the chapters window would never appear. |

Both are read when an episode is opened, so they take effect on the *next* one.
They are DOM overlay controls and therefore invisible inside an XR session —
set them before entering VR.

## Server configuration

The server URL is **code-only**: there is no UI field and no environment
variable. The client is constructed with no options at all, so it falls back to
`DEFAULT_BASE_URL` in `src/opencast/client.ts` — `https://develop.opencast.org`.
This is what `src/App.tsx` actually contains:

```ts
const client = useMemo(
  () => (import.meta.env.DEV ? new SyntheticDualStreamClient() : new OpencastClient()),
  [],
)
```

To point the player elsewhere, pass `baseUrl` to both constructors — that is
the whole change:

```ts
const client = useMemo(
  () => {
    const options = { baseUrl: 'https://opencast.example.org' }   // <- added
    return import.meta.env.DEV ? new SyntheticDualStreamClient(options) : new OpencastClient(options)
  },
  [],
)
```

(`SyntheticDualStreamClient` extends `OpencastClient` and declares no
constructor of its own, so it accepts the same options.) Vite's HMR picks the
edit up without a restart.

The server must send permissive CORS headers, since the browser talks to it
directly and anonymously.

`OpencastClientOptions` carries the two seams the data layer was designed
around, both unused in v1 and both fully tested:

- **`authorize(init, url) => RequestInit`** — shapes every request the client
  makes, API calls *and* caption fetches (real deployments ACL-gate WebVTT
  files too). This is where a JWT bearer header, an LTI-derived token, or
  `credentials: 'include'` for a session cookie goes.
- **`resolveAssetUrl(url) => string`** — rewrites every media/image URL that
  leaves the data layer: track URLs, episode thumbnails, segment previews.
  This is where signed-URL minting goes. One caveat, documented at the call
  site: caption-track selection scores a `.vtt` suffix as a weak secondary
  signal, so a rewrite that strips the suffix leaves that choice resting on
  the MIME type alone.

Auth itself (session cookie, LTI, JWT) is deliberately out of v1.

## Architecture

Three layers, the lower two React-free and fixture-tested:

```
src/
├── opencast/   Search-API client, tolerant response parsing, track/quality
│               selection, WebVTT parser, auth + asset-URL hooks
├── player/     media-element lifecycle, the sync engine (master clock, drift
│               bands, stall handling, master election and handover), and the
│               zustand store that owns both
└── windows/    one uikit component per window, each with its decision logic
                split into a pure, unit-tested `*State.ts` sibling
```

The split in `windows/` is not decoration: `@react-three/uikit` components
cannot render meaningfully in jsdom, so anything worth asserting on lives
outside the component and the component stays thin glue. `App.tsx` composes
the two modes (browse = library window; player = video windows + controls +
chapters + series + transcript + HUD + dock transport).

Two rules worth knowing before editing:

- **The shell owns "is this window on screen"; the store owns "is this stream
  loaded".** Closing a stream must go through the shell
  (`shellStore.close(videoWindowId(f))`), never `store.closeStream()`
  directly — a bare store call is silently undone by the watcher that
  reconciles the two. See the doc comments in `player/store.ts` and
  `windows/videoWindowState.ts`.
- **`VideoSurface` never touches playback.** Playback belongs entirely to the
  sync engine; a window unmounting only drops a texture.

`window.__opencastPlayer` is published in every build (see
`verificationHandle.tsx`): `pump()` forces frames, `store` is the player
store, and `sample()` returns one numeric snapshot of every stream — master,
play state, per-stream `currentTime`, `muted`, `paused`, `readyState`. It is
how every drift and handover number in this project was measured, and it works
over `chrome://inspect` against a headset.

## Scope and non-goals

Out of v1 by decision, not by omission: authentication (the hooks above
exist), quizzes, HLS/adaptive streaming, the Opencast External API, a spatial
gallery browse mode, and any interactive head-locked UI (aiming at UI that
moves with your head is a VR anti-pattern — the timeline lives in the dock,
and the HUD only ever *displays*).

## Known limitations

- **Curved-window mode scrubs imprecisely.** With the experimental "Curved"
  mode on (the dock's `...` menu), timeline drags land up to ~6.4 % off near the panel's
  edges: the bend is a vertex-shader effect the pointer maths cannot see.
  Clamping and monotonicity still hold and **flat mode, the default, is
  exact**. A proper fix needs a new `sphere-shell` API (a dock bend frame, or
  a ray-correction helper) and is deferred to the next library round.
- **Minimized streams keep decoding.** Minimizing drops the texture, not the
  playback — by design, so the stream stays on the shared clock and comes back
  in sync. The cost is decode plus bandwidth for a window you cannot see.
- **The last open stream's ✕ is inert.** `sphere-shell` 0.3.0 has no
  `closable` prop, so the refusal happens after the shell has already closed
  the window: it is closed and immediately restored, costing one
  unmount/remount frame and a silent focus change.
- **Non-playable episode tiles still show a hover affordance**, even though
  clicking them does nothing.
- **Six or more video flavors** overlap by about a degree of azimuth (no real
  recording has that many).
- **Long caption lines are hard-wrapped by character count** and can break
  mid-word.
- **The head-locked HUD has never been seen through a headset's lenses.**
  Keystone/shear in stereo and the caption + seek-feedback stacking are the
  top items on the hardware checklist.
- `@react-three/uikit` 1.0.74 has several reproduced defects this app works
  around (a `hover={undefined}` reconciler crash, missing glyphs for
  typographic punctuation, a many-wrapped-lines rendering limit, stale
  `e.point` under pointer capture). Read
  [`docs/UIKIT-NOTES.md`](docs/UIKIT-NOTES.md) before re-diagnosing one
  from scratch.

## Documentation

| Where | What |
|---|---|
| [`docs/QUEST-VALIDATION-PLAYER.md`](docs/QUEST-VALIDATION-PLAYER.md) | The hardware checklist: how to reach a dev server from a headset, the Definition of Done as checks, and what is still unverified. |
| [`docs/design-spec.md`](docs/design-spec.md) | The design spec this was built from — error cases (§9) and the Definition of Done (§11) included. |
| [`docs/UIKIT-NOTES.md`](docs/UIKIT-NOTES.md) | Real `@react-three/uikit` defects and their workarounds. |
| [`sphere-shell`](https://github.com/rrolf/sphere-shell) | The window-shell API this app is written against. |
| [`docs/INSTALL-rocky-linux-10.md`](docs/INSTALL-rocky-linux-10.md) | Production deployment as a static site on Rocky Linux 10 (nginx, TLS, SELinux, firewalld) — German, for university admins. |

## License

[Apache License 2.0](LICENSE). Copyright 2026 Universität Osnabrück,
virtUOS. Author: Rüdiger Rolf. See [`NOTICE`](NOTICE) for attribution.
