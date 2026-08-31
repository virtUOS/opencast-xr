// This app's `@react-three/uikit` tree has hit several real, reproduced
// library defects/quirks (a `hover={undefined}` reconciler crash, missing
// glyphs for certain punctuation, a wrapped-line rendering limit, stale
// `e.point` under pointer capture) - see `docs/UIKIT-NOTES.md` at the repo
// root before spending time re-diagnosing one of these from scratch.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { XR } from '@react-three/xr'
import { useStore } from 'zustand'
import { WindowShell, type AppDockMenuItem } from 'sphere-shell'
import { SHELL_RADIUS, xrStore } from './xrStore'
import { VerificationHandle } from './verificationHandle'
import { OpencastClient } from './opencast/client'
import { captionPrefsStorage, readCaptionPrefs, writeCaptionPrefs } from './captionPrefs'
import {
  availableBackground,
  backgroundColorFor,
  backgroundToggleAvailable,
  backgroundToggleLabel,
  otherBackground,
  sessionModeFor,
  type BackgroundMode,
} from './backgroundMode'
import { backgroundPrefsStorage, readBackgroundPrefs, writeBackgroundPrefs } from './backgroundPrefs'
import { tutorialPrefsStorage, readTutorialPrefs, writeTutorialPrefs } from './tutorialPrefs'
import { reportPageLoadHit } from './telemetry'
import { createPlayerStore } from './player/store'
import { LibraryWindow } from './windows/LibraryWindow'
import { VideoWindows } from './windows/VideoWindows'
import { PAIR_EDGE_SNAP_GAP_DEG } from './windows/videoWindowState'
import { DockTransport } from './windows/DockTransport'
import { ControlsWindow } from './windows/ControlsWindow'
import { ChaptersWindow } from './windows/ChaptersWindow'
import { SeriesWindow } from './windows/SeriesWindow'
import { TranscriptWindow } from './windows/TranscriptWindow'
import { SubtitleHud } from './windows/SubtitleHud'
import { XRPlayerControls } from './windows/XRPlayerControls'
import { createSeriesState } from './windows/seriesState'
import { SyntheticDualStreamClient } from './dev/syntheticDualStream'
import { TOUR_STEPS } from './windows/tourSteps'
import { INITIAL_TOUR_STATE, isLastTourStep, reduceTour } from './windows/tourState'
import {
  INITIAL_TOUR_GATE_STATE,
  advanceTourGateEpoch,
  markTourShown,
  tourStartDecision,
} from './windows/tourGate'
import { guardXRStoreSubscriber } from './xrStoreSubscriberGuard'

/**
 * Why WebXR is or isn't available, as a short line we can render on screen.
 *
 * Copied from apps/demo/src/App.tsx's `describeXrEnvironment`/`XrStatus`
 * (see that file's doc comment for the full rationale: hiding the button
 * when `navigator.xr` is missing makes "can't start a session" and "still
 * probing" indistinguishable). `ar` was dropped when this was first trimmed
 * for the player ("the player has no passthrough/background mode"); it is
 * back now that the start overlay offers a background choice - `ar: false`
 * is what disables the "Durchsichtig" radio (see `availableBackground` in
 * `backgroundMode.ts`) instead of leaving it selectable and failing on click.
 */
type XrStatus =
  | { kind: 'checking' }
  | { kind: 'ready'; vr: boolean; ar: boolean }
  | { kind: 'unavailable'; reason: string }

function describeXrEnvironment(): XrStatus | null {
  if (!window.isSecureContext) {
    return {
      kind: 'unavailable',
      reason:
        'no secure context — WebXR needs https with a certificate the device trusts (clicking past a warning is not enough), or http://localhost',
    }
  }
  if (!('xr' in navigator) || navigator.xr == null) {
    return { kind: 'unavailable', reason: 'navigator.xr missing — this browser exposes no WebXR API' }
  }
  return null
}

export function App() {
  // One OpencastClient + one PlayerStore per <App> mount, not module-level
  // like xrStore.ts. xrStore has to be module-level because it's imported by
  // sibling modules that need the SAME store identity outside this component
  // (none exist yet, but the demo's dock controls are the precedent). The
  // player store has no such cross-module consumer — everything that touches
  // it lives inside <App>'s own tree — and its `dispose()` is a ONE-SHOT
  // teardown (see store.ts: "not reusable after dispose"), which pairs
  // naturally with a component's mount/unmount rather than a module-level
  // singleton that would either leak its 250ms tick interval across HMR
  // reloads or need its own ad hoc "was it already disposed" guard.
  //
  // In a dev build the client is the SyntheticDualStreamClient subclass, so the
  // „Zweiter Stream (Test)" checkbox below has something to switch (see
  // dev/syntheticDualStream.ts for why the duplicate stream is the only way to
  // exercise the sync engine against develop.opencast.org, whose recordings all
  // have a single video flavor). A production build gets the plain client and
  // never renders the checkbox.
  const client = useMemo(
    () => (import.meta.env.DEV ? new SyntheticDualStreamClient() : new OpencastClient()),
    [],
  )
  const playerStore = useMemo(() => createPlayerStore(client), [client])
  useEffect(() => {
    return () => playerStore.getState().dispose()
  }, [playerStore])

  // Caption size and position survive a reload - they are accessibility
  // settings, and one that has to be re-found and re-pressed on every visit is
  // one that gets pressed once and then endured. See `captionPrefs.ts` for why
  // only these two persist, and why every read and write is total (a missing,
  // corrupt or hostile value, and a storage that throws outright, all end up at
  // the defaults rather than at an exception or a NaN in the HUD).
  //
  // Here rather than inside the store, so the store stays free of I/O and
  // stays testable without a DOM. Applied through the store's own actions, so
  // the one-writer discipline holds: this is not a second path into those
  // fields, it is a caller of the only path.
  useEffect(() => {
    const storage = captionPrefsStorage()
    const prefs = readCaptionPrefs(storage)
    playerStore.getState().setSubtitleScale(prefs.scale)
    playerStore.getState().setSubtitleOffset(prefs.offsetDeg)
    // Written on every change rather than on unmount: a tab that is closed (or
    // a headset session that ends) never runs an unmount handler reliably, and
    // the write is one small `setItem` on a control the user presses by hand.
    let last = prefs
    return playerStore.subscribe((state) => {
      if (state.subtitleScale === last.scale && state.subtitleOffsetDeg === last.offsetDeg) return
      last = { scale: state.subtitleScale, offsetDeg: state.subtitleOffsetDeg }
      writeCaptionPrefs(storage, last)
    })
  }, [playerStore])
  const mode = useStore(playerStore, (s) => s.mode)

  // Whether the tutorial tour is switched on - the start overlay's own
  // checkbox, next to the background choice. Defaults to ON
  // (`tutorialPrefs.ts`'s own doc comment: a conference visitor who has never
  // seen the app needs it explained without anyone finding and flipping a
  // setting first) and persists across reloads in the same
  // `opencastxr.player.*` key family as the caption/background prefs.
  // Completing or skipping a shown tour never writes here - only this
  // checkbox does (see `setTutorialEnabled` below and `tourGate.ts`'s doc
  // comment on why the two are kept apart).
  const tutorialStorage = useMemo(() => tutorialPrefsStorage(), [])
  const [tutorialEnabled, setTutorialEnabledState] = useState<boolean>(
    () => readTutorialPrefs(tutorialPrefsStorage()).enabled,
  )
  const setTutorialEnabled = useCallback(
    (enabled: boolean) => {
      setTutorialEnabledState(enabled)
      writeTutorialPrefs(tutorialStorage, { enabled })
    },
    [tutorialStorage],
  )

  // The tour's own runtime state (which step, if any, is showing) - see
  // `windows/tourState.ts`. Advanced/skipped only from the bubble itself
  // (`DockTransport`'s `tour` prop, below); started only by the effect right
  // after it.
  const [tour, setTour] = useState(INITIAL_TOUR_STATE)
  const advanceTour = useCallback(() => {
    setTour((state) => reduceTour(state, { type: 'advance' }, TOUR_STEPS.length))
  }, [])
  const skipTour = useCallback(() => {
    setTour((state) => reduceTour(state, { type: 'skip' }, TOUR_STEPS.length))
  }, [])

  // WHEN the tour is allowed to start - a plain mutable ref, not React state:
  // nothing ever reads it to render, it is only ever consulted and updated at
  // the two moments described in `windows/tourGate.ts`'s own doc comment
  // (a fresh immersive session starting, and player mode being entered).
  const tourGateRef = useRef(INITIAL_TOUR_GATE_STATE)

  // The ONE place either of the two effects below is allowed to start the
  // tour - both funnel through this, so `markTourShown`'s bookkeeping cannot
  // diverge between them (fix-round finding: the first cut had the epoch-bump
  // effect update the gate but never consult `tourStartDecision`/`markTourShown`
  // at all, which is exactly the conference bug below fixes). `mode` is read
  // fresh from the store here rather than closed over from the component's
  // own `mode` variable, so this never acts on a stale value regardless of
  // which effect (and which dependency array) calls it.
  const maybeStartTour = useCallback(
    (edge: { epochChanged: boolean; modeEdge: boolean }) => {
      const currentMode = playerStore.getState().mode
      if (
        tourStartDecision({
          epochChanged: edge.epochChanged,
          modeEdge: edge.modeEdge,
          mode: currentMode,
          enabled: tutorialEnabled,
          gateState: tourGateRef.current,
        })
      ) {
        tourGateRef.current = markTourShown(tourGateRef.current)
        setTour(reduceTour(INITIAL_TOUR_STATE, { type: 'start' }, TOUR_STEPS.length))
      }
    },
    [playerStore, tutorialEnabled],
  )

  // Bumps the gate's epoch on every FRESH immersive session start - mirrors
  // the telemetry effect below, which subscribes to the same `xrStore` for
  // the same reason (reading the ACTUAL granted session mode, not merely a
  // request). See `tourGate.ts`'s `advanceTourGateEpoch` for why only a
  // `'none'` -> immersive transition counts.
  //
  // ALSO calls `maybeStartTour` on that same bump - not just `App.tsx`'s
  // other effect below - because a fresh session can start while player mode
  // is ALREADY active and never leaves it: the exact conference case this
  // feature exists for (the next visitor dons the headset while the
  // previous visitor's recording is still open - `openEpisode` short-
  // circuits on the same id, so there is no `'browse' -> 'player'` edge
  // anywhere in that trace for the other effect to catch). `epochChanged`
  // being true is what lets `tourStartDecision` fire here; it still refuses
  // unless `mode` is ALSO `'player'` right now, so entering VR from the
  // library (nothing open yet) does not start the tour early - see
  // `tourStartDecision`'s own doc comment and `tourGate.test.ts`'s "four
  // scenarios" for the traced-through proof.
  //
  // The whole body runs through `guardXRStoreSubscriber` - see that module's
  // doc comment for why a subscriber here must never be allowed to throw:
  // `xrStore` notifies every subscriber synchronously from inside `setState`
  // via a bare `Set.forEach`, which has no exception isolation, and
  // `DockTransport`'s own `useXRSession()` subscription (mounted fresh every
  // time player mode is entered) always lands AFTER this one in that same
  // notification order.
  useEffect(() => {
    return xrStore.subscribe((state) => {
      guardXRStoreSubscriber('tour gate', () => {
        // `state.mode` is `@react-three/xr`'s own `XRSessionMode | null` -
        // wider than `tourGate.ts`'s `XrSessionMode`, which only distinguishes
        // "no immersive session" from the two this app ever requests
        // (`sessionModeFor` - `enterVR`/`enterAR` never request `'inline'`).
        // `null` (before the store's first frame) and `'inline'` both read as
        // "no session" here, exactly like the library's own explicit `'none'`.
        const xrMode = state.mode === 'immersive-vr' || state.mode === 'immersive-ar' ? state.mode : 'none'
        const epochBefore = tourGateRef.current.epoch
        tourGateRef.current = advanceTourGateEpoch(tourGateRef.current, xrMode)
        maybeStartTour({ epochChanged: tourGateRef.current.epoch !== epochBefore, modeEdge: false })
      })
    })
  }, [maybeStartTour])

  // Starts the tour the moment player mode is entered ("wenn der Player
  // geöffnet wird"). Watches the `'browse' -> 'player'` EDGE, not merely
  // `mode === 'player'`: the latter would also fire for the dock's own
  // previous/next episode buttons and the Reihe window (which change the
  // open episode without ever leaving player mode), re-showing the tour on
  // every episode change within one visit - `tourStartDecision`'s own
  // `shouldShowTour` epoch check is what actually decides whether THIS edge
  // still gets to start it (e.g. it does nothing if the effect above just
  // started it for the same epoch already - see `tourGate.test.ts`
  // scenario 3, "VR entered from browse, then a recording is opened").
  const previousModeRef = useRef(mode)
  useEffect(() => {
    if (previousModeRef.current !== 'player' && mode === 'player') {
      maybeStartTour({ epochChanged: false, modeEdge: true })
    }
    previousModeRef.current = mode
  }, [mode, maybeStartTour])

  // The open episode's series episode list, fetched ONCE and read by two
  // consumers: `SeriesWindow` (which lists it) and `DockTransport`'s
  // previous/next episode controls (which need the neighbours in the same
  // order). `SeriesWindow` used to create this itself; a second instance in
  // the dock would fetch the same series again and the two could disagree
  // mid-pagination, so it is hoisted here - one fetch, one order, two readers.
  //
  // Owned here rather than in the player store because it is a WINDOW's
  // fetch/pagination state (its own race-token discipline, its own retry), not
  // playback state, and because putting it in `openEpisode` would put an extra
  // network round trip and an extra failure mode on the critical path of
  // opening a recording.
  const seriesStore = useMemo(() => createSeriesState(client), [client])
  const openSeriesId = useStore(playerStore, (s) => s.episode?.seriesId)
  useEffect(() => {
    if (openSeriesId) void seriesStore.getState().load(openSeriesId)
  }, [seriesStore, openSeriesId])

  // Non-null exactly in a dev build (see the client memo above). The
  // `instanceof` keeps the checkbox tied to the client that can actually honour
  // it - but it must sit BEHIND the `import.meta.env.DEV` short-circuit, not
  // instead of it: on its own it is a live reference to
  // SyntheticDualStreamClient, which pins the class, the syntheticDualStream
  // helper, the flavor array, the checkbox JSX and its German strings into the
  // production bundle (grep-confirmed - they shipped, behaviourally inert, in
  // the first cut of this file). Vite replaces `import.meta.env.DEV` with the
  // literal `false` in a production build, so `false && ...` folds statically,
  // `devClient` becomes a constant `null`, and everything reachable only
  // through it is dead code the bundler drops.
  const devClient = import.meta.env.DEV && client instanceof SyntheticDualStreamClient ? client : null
  const [syntheticSecondStream, setSyntheticSecondStream] = useState(false)
  const toggleSyntheticSecondStream = useCallback(
    (on: boolean) => {
      // The flag lives on the client (read per getEpisode call), not in React
      // state - the store must not be rebuilt for it. React state here is only
      // the checkbox's own appearance.
      if (devClient) devClient.syntheticSecondStream = on
      setSyntheticSecondStream(on)
    },
    [devClient],
  )

  // Same pattern, same reasoning, as syntheticSecondStream above - see
  // dev/syntheticDualStream.ts's `buildTestChapters` doc comment for why
  // ChaptersWindow (Task 14) needs this at all (develop.opencast.org has no
  // segmented episodes).
  const [testChapters, setTestChapters] = useState(false)
  const toggleTestChapters = useCallback(
    (on: boolean) => {
      if (devClient) devClient.testChapters = on
      setTestChapters(on)
    },
    [devClient],
  )

  // Same pattern again - see `dev/syntheticDualStream.ts`'s `buildTestLongCues`
  // doc comment for why this exists: reproducing „Die Zeilen im Transkript
  // überlagern sich leider immer noch" needs cues long enough to wrap 2-3
  // visual lines each, and neither develop.opencast.org's nor explore's real
  // fixtures are guaranteed to have one open at hand during a live check.
  const [testLongCues, setTestLongCues] = useState(false)
  const toggleTestLongCues = useCallback(
    (on: boolean) => {
      if (devClient) devClient.testLongCues = on
      setTestLongCues(on)
    },
    [devClient],
  )

  const [xrStatus, setXrStatus] = useState<XrStatus>({ kind: 'checking' })
  const [enterError, setEnterError] = useState<string | null>(null)

  useEffect(() => {
    const environment = describeXrEnvironment()
    if (environment) {
      setXrStatus(environment)
      return
    }
    let cancelled = false
    Promise.all([
      navigator.xr!.isSessionSupported('immersive-vr'),
      navigator.xr!.isSessionSupported('immersive-ar'),
    ])
      .then(([vr, ar]) => {
        if (cancelled) return
        setXrStatus(
          vr || ar
            ? { kind: 'ready', vr, ar }
            : {
                kind: 'unavailable',
                reason: 'browser has WebXR but reports neither an immersive-vr nor an immersive-ar device',
              },
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setXrStatus({
          kind: 'unavailable',
          reason: `isSessionSupported threw: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Anonymous visitor beacon (see src/telemetry.ts and counter/README.md for
  // the service this reports to, and the design rationale — country + VR/AR
  // split only, no IP retained). Production builds only: `import.meta.env.DEV`
  // is Vite's static build-mode flag (see xrStore.ts's identical guard on the
  // WebXR emulator for the same reasoning), so `pnpm dev` never sends
  // anything and a `vite build` is the only build that ever does. One 'page'
  // hit per page load, fired once on mount — reportPageLoadHit's own
  // one-shot-per-kind guard (telemetry.ts's `shouldSendHit`) makes a second
  // call here harmless if this effect were ever to re-run.
  useEffect(() => {
    if (import.meta.env.DEV) return
    reportPageLoadHit('page')
  }, [])

  // The 'vr'/'ar' beacon, sent the first time THIS page load's xrStore
  // reports the matching session mode actually being granted — reading
  // `xrStore.getState().mode` (not `effectiveBackground` below, which is
  // only a REQUEST) is the same "actual session mode" seam `enterVR` itself
  // relies on via `sessionModeFor`. Re-entering the same mode later in this
  // page load sends nothing further (see telemetry.ts's module doc comment
  // on why that's the deliberate choice, not a gap).
  // Guarded the same way, and for the same reason, as the tour-gate
  // subscriber above (`guardXRStoreSubscriber`'s own doc comment) - even
  // though `reportPageLoadHit` already cannot throw on its own
  // (`telemetry.ts`'s `reportHit` swallows everything the transport does),
  // this stays wrapped too: the guard's whole point is that NOTHING
  // registered on `xrStore` from this codebase is allowed to be the one that
  // breaks a later subscriber's notification, regardless of whether today's
  // body happens to be provably safe already.
  useEffect(() => {
    if (import.meta.env.DEV) return
    return xrStore.subscribe((state) => {
      guardXRStoreSubscriber('telemetry', () => {
        if (state.mode === 'immersive-vr') reportPageLoadHit('vr')
        else if (state.mode === 'immersive-ar') reportPageLoadHit('ar')
      })
    })
  }, [])

  // What is behind the windows once a session starts. 'black' (the player's
  // original, and only, look) is the default, chosen on the start overlay or
  // flipped from the dock's three-dot menu (see `chooseBackgroundRow` below -
  // the in-session row ends the session, since the mode is a property of the
  // session type and cannot change within one). Survives a reload via
  // `backgroundPrefs.ts`, same defensive try/catch contract as
  // `captionPrefs.ts`, in the same `opencastxr.player.*` key family - lazily
  // read once, on mount, exactly like the caption prefs' own `useEffect`
  // below (kept as a separate effect, not merged with it: this preference
  // has its own storage key and its own reader, the start overlay, not the
  // player store).
  const backgroundStorage = useMemo(() => backgroundPrefsStorage(), [])
  const [background, setBackgroundState] = useState<BackgroundMode>(
    () => readBackgroundPrefs(backgroundPrefsStorage()).background,
  )
  const chooseBackground = useCallback(
    (next: BackgroundMode) => {
      setBackgroundState(next)
      writeBackgroundPrefs(backgroundStorage, { background: next })
    },
    [backgroundStorage],
  )
  // Never hands `xrStore.enterAR()` a mode this device has not actually
  // reported support for - see `availableBackground`'s doc comment. Only
  // meaningful once `xrStatus` is `'ready'`; before that (or if WebXR is
  // unavailable outright) the enter button itself is not rendered, so no
  // click can reach this with a stale `false`.
  const arAvailable = xrStatus.kind === 'ready' && xrStatus.ar
  const effectiveBackground = availableBackground(background, arAvailable)
  const sceneBackgroundColor = backgroundColorFor(effectiveBackground)

  const enterVR = useCallback(() => {
    setEnterError(null)
    const mode = sessionModeFor(effectiveBackground)
    const enter = mode === 'immersive-ar' ? xrStore.enterAR() : xrStore.enterVR()
    void Promise.resolve(enter).catch((error: unknown) => {
      setEnterError(`Sitzung konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [effectiveBackground])

  /**
   * The dock's own background row (sphere-shell 0.3.1's `dockMenuItems` /
   * `AppDockMenuItem` API - see `backgroundMode.ts`'s doc comment for why
   * this was previously scoped to the start overlay alone). Label names the
   * SWITCH TARGET (`backgroundToggleLabel`), so „what happens if I press
   * this" always has one answer.
   *
   * ## Why `onSelect` ENDS the session rather than re-entering the other mode directly
   *
   * A background switch is a SESSION MODE switch (`immersive-vr` <->
   * `immersive-ar` - see `sessionModeFor`), and WebXR does not allow a second
   * immersive session while one is active. The installed
   * `@pmndrs/xr@6.6.30`'s `enterAR()`/`enterVR()` (`xrStore.ts`'s own import)
   * just call `navigator.xr.requestSession(mode, ...)` with no guard of their
   * own (`node_modules/.pnpm/@pmndrs+xr@.../dist/store.js`'s
   * `enterXRSession`), so calling either while a session is running rejects
   * per the WebXR spec, which refuses a second concurrent immersive session
   * outright. The store's own `destroy()` doc comment names the sanctioned
   * way out - "for exiting XR use store.getState().session?.end())" - and
   * there is no combined "end and re-enter" helper anywhere in the installed
   * 0.3.1 `.d.ts` or `@pmndrs/xr` source.
   *
   * A chained `await session.end(); await xrStore.enterAR()` was considered
   * and rejected: `requestSession` requires "transient activation" from a
   * user gesture, and while the click that opens this menu row IS one,
   * `session.end()` is itself async - it does real teardown work before its
   * promise resolves - and whether that gap preserves the gesture's
   * activation on real Quest Browser hardware is a spec grey area this repo
   * has no way to verify (no headset, no sudo for a live WebXR check here -
   * see the task's own gate on that). Ending the session and leaving
   * re-entry to the overlay is the variant defensible from the installed
   * `.d.ts`/source alone: `session.end()` is exactly what the library
   * documents, the overlay already reads the FLIPPED preference
   * (`chooseBackground` below runs before the `end()` call), and the user
   * lands one clearly-labelled click away from the mode they just asked for
   * - see `enterVR` above and the radios' `checked` state.
   *
   * Outside a session (browse mode, or a magic-window desktop/tablet visit -
   * see sphere-shell's README on why that is not a degraded fallback path)
   * `xrStore.getState().session` is `undefined`, so this only flips the
   * persisted preference for the next start - exactly the „outside a
   * session the row still works" requirement.
   */
  const chooseBackgroundRow = useCallback(() => {
    chooseBackground(otherBackground(effectiveBackground))
    xrStore.getState().session?.end()
  }, [effectiveBackground, chooseBackground])

  // Hidden rather than shown-disabled: `AppDockMenuItem` has no `enabled`
  // field (unlike the shell's own built-in rows - see sphere-shell's
  // `AppDockMenuItem` doc comment, which explicitly rules out inventing a
  // disabled affordance for app rows), so there is no way to grey this row
  // out in place. `black` is always reachable, so this only ever hides the
  // switch-to-passthrough row on a device with no `immersive-ar` support -
  // reusing `availableBackground` via `backgroundToggleAvailable` rather than
  // re-deriving that fallback rule a second time.
  const dockMenuItems = useMemo<AppDockMenuItem[]>(() => {
    if (!backgroundToggleAvailable(effectiveBackground, arAvailable)) return []
    return [
      {
        id: 'background',
        label: backgroundToggleLabel(effectiveBackground),
        onSelect: chooseBackgroundRow,
      },
    ]
  }, [effectiveBackground, arAvailable, chooseBackgroundRow])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', zIndex: 1, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {/* The background choice, decided here rather than in-session:
            sphere-shell 0.3.0's dock „..." menu takes no app-supplied rows
            (see backgroundMode.ts's doc comment) - so the start overlay is
            the only place this can be offered today, and it doubles as the
            way back after a restart, since it remembers the last choice
            (backgroundPrefs.ts) and a viewer who exits a black session to
            get passthrough (or back) lands here with the OTHER option one
            click away. Radio-style rather than a toggle: both options are
            named plainly, so there is nothing to infer from a single
            button's current label the way the demo's dock button has to. */}
        {xrStatus.kind === 'ready' && (
          <fieldset
            style={{
              display: 'flex', gap: 10, alignItems: 'center', margin: 0,
              color: '#e8e8ee', background: '#22222a', border: '1px solid #44444e',
              borderRadius: 4, padding: '4px 10px', font: '12px system-ui, sans-serif',
            }}
          >
            <legend style={{ padding: '0 4px' }}>Hintergrund</legend>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="radio"
                name="background"
                checked={effectiveBackground === 'black'}
                onChange={() => chooseBackground('black')}
              />
              Schwarz
            </label>
            <label
              style={{
                display: 'flex', gap: 4, alignItems: 'center',
                color: xrStatus.ar ? undefined : '#5a5a65',
              }}
              title={xrStatus.ar ? undefined : 'Kein Passthrough: dieses Gerät meldet keinen immersive-ar Modus'}
            >
              <input
                type="radio"
                name="background"
                disabled={!xrStatus.ar}
                checked={effectiveBackground === 'passthrough'}
                onChange={() => chooseBackground('passthrough')}
              />
              Durchsichtig (Passthrough)
            </label>
          </fieldset>
        )}
        {/* Next to the background choice, but NOT gated behind
            `xrStatus.kind === 'ready'` like that fieldset is: the tour is
            just as meaningful for a magic-window visit (no VR entry at all -
            see `chooseBackgroundRow`'s doc comment on why this app treats
            that as a first-class way to watch, not a fallback) as it is
            inside a session, so this control must not disappear on a device
            that cannot enter VR to begin with. See `tutorialPrefs.ts` for
            why the default is ON and `tourGate.ts` for when it actually
            fires. */}
        <label
          style={{
            color: '#e8e8ee', background: '#22222a', border: '1px solid #44444e',
            borderRadius: 4, padding: '6px 10px', font: '12px system-ui, sans-serif',
            display: 'flex', gap: 6, alignItems: 'center',
          }}
          title="Zeigt beim Öffnen einer Aufzeichnung eine kurze Einführung in Dock und Steuerung - an Sprechblasen an den jeweiligen Buttons. Nützlich, wenn andere die Anwendung ohne Erklärung ausprobieren."
        >
          <input
            type="checkbox"
            checked={tutorialEnabled}
            onChange={(e) => setTutorialEnabled(e.target.checked)}
          />
          Tutorial
        </label>
        {xrStatus.kind === 'ready' && (
          <button onClick={enterVR} style={{ padding: '8px 16px' }}>
            VR betreten
          </button>
        )}
        {enterError != null && (
          <span
            style={{
              color: '#ffd8de', background: '#3a2028', border: '1px solid #c04858',
              borderRadius: 4, padding: '6px 10px', font: '12px system-ui, sans-serif',
              maxWidth: '40vw',
            }}
          >
            {enterError}
          </span>
        )}
        {devClient && (
          <label
            style={{
              color: '#e8e8ee', background: '#22222a', border: '1px solid #44444e',
              borderRadius: 4, padding: '6px 10px', font: '12px system-ui, sans-serif',
              display: 'flex', gap: 6, alignItems: 'center',
            }}
            title="Dupliziert die einzige Videospur der nächsten geöffneten Aufzeichnung als zweiten Stream (presentation/synthetic) — nur für Entwicklung."
          >
            <input
              type="checkbox"
              checked={syntheticSecondStream}
              onChange={(e) => toggleSyntheticSecondStream(e.target.checked)}
            />
            Zweiter Stream (Test)
          </label>
        )}
        {devClient && (
          <label
            style={{
              color: '#e8e8ee', background: '#22222a', border: '1px solid #44444e',
              borderRadius: 4, padding: '6px 10px', font: '12px system-ui, sans-serif',
              display: 'flex', gap: 6, alignItems: 'center',
            }}
            title="Fügt der nächsten geöffneten Aufzeichnung drei konstruierte Kapitelmarken (0s/60s/120s) hinzu — nur für Entwicklung, da develop.opencast.org keine segmentierten Aufzeichnungen hat."
          >
            <input
              type="checkbox"
              checked={testChapters}
              onChange={(e) => toggleTestChapters(e.target.checked)}
            />
            Kapitel (Test)
          </label>
        )}
        {devClient && (
          <label
            style={{
              color: '#e8e8ee', background: '#22222a', border: '1px solid #44444e',
              borderRadius: 4, padding: '6px 10px', font: '12px system-ui, sans-serif',
              display: 'flex', gap: 6, alignItems: 'center',
            }}
            title="Ersetzt das Transkript der nächsten geöffneten Aufzeichnung durch fünf lange, mehrzeilige Testzeilen — nur für Entwicklung."
          >
            <input
              type="checkbox"
              checked={testLongCues}
              onChange={(e) => toggleTestLongCues(e.target.checked)}
            />
            Lange Zeilen (Test)
          </label>
        )}
        {xrStatus.kind !== 'ready' && (
          <span
            style={{
              color: '#e8e8ee',
              background: '#3a2a2a',
              border: '1px solid #6a4a4a',
              borderRadius: 4,
              padding: '6px 10px',
              font: '12px system-ui, sans-serif',
              maxWidth: '60vw',
            }}
          >
            {xrStatus.kind === 'checking'
              ? 'No VR: checking…'
              : `No VR: ${xrStatus.reason} · secureContext=${String(window.isSecureContext)} · navigator.xr=${'xr' in navigator && navigator.xr != null ? 'yes' : 'no'} · ${location.protocol}//${location.hostname}`}
          </span>
        )}
      </div>
        {/* Only shown when the beacon (telemetry.ts) can actually be active -
            a dev build never sends it (see the useEffect above), so a note
            about it here would be misleading noise while developing. Styled
            as unobtrusive fine print, consistent with (but visually lighter
            than) the status bar above it - this is disclosure, not a
            warning. See counter/README.md and telemetry.ts for what is and
            isn't collected; the wording itself was agreed directly with the
            operator (see docs/INSTALL-rocky-linux-10.md's counter section
            and README.md for the same text in context). */}
        {!import.meta.env.DEV && (
          <span style={{ color: '#8a8a96', font: '11px system-ui, sans-serif', maxWidth: '60vw' }}>
            Anonyme Nutzungsstatistik: gezählt werden nur Tag, Herkunftsland und ob per VR-Brille oder Browser –
            ohne Cookies, ohne Speicherung von IP-Adressen.
          </span>
        )}
      </div>
      <Canvas camera={{ position: [0, 0, 0.01], fov: 70 }}>
        <VerificationHandle store={playerStore} />
        {/* Rendered conditionally rather than always-on-black: a null
            background is what turns the flat-browser canvas transparent
            (index.html's checkerboard shows through) and, once inside an
            immersive-ar session, is the whole passthrough mechanism - see
            backgroundColorFor's doc comment and apps/demo/src/App.tsx's
            identical `{backgroundColor != null && <color .../>}` line. */}
        {sceneBackgroundColor != null && (
          <color attach="background" args={[sceneBackgroundColor]} />
        )}
        <ambientLight intensity={1} />
        <XR store={xrStore}>
          <WindowShell
            radius={SHELL_RADIUS}
            // Curved is the default player mode now ("Können wir curved noch
            // zum default machen?") - windows and the dock are drawn bent
            // onto the shell sphere from the first frame. The dock's own
            // three-dot menu still has the Curved/Flat row (sphere-shell's
            // `useCurved`/`setCurved`), so a viewer can drop back to flat at
            // runtime; that toggle is entirely library behavior and untouched
            // here. See `DockTransport.tsx`'s doc comment for the one
            // consequence of this flip: timeline-scrub accuracy under curved
            // mode is a known, tracked limitation, not a new bug.
            curved
            // A Quest 3 session found a magnetically-snapped pair of windows
            // too tightly packed together under the library's own default
            // (1.0 deg): „Gern ein wenig mehr Abstand wählen" was the OPPOSITE
            // ask that motivated sphere-shell 0.3.4's default in the first
            // place, but this app's own hardware feedback round wants it
            // tighter still. `PAIR_EDGE_SNAP_GAP_DEG` (0.5) is shared with
            // `videoWindowState.ts`'s pair START layout - see that file's doc
            // comment - so a viewer who drags two windows apart and lets them
            // snap back together sees exactly the same gap they started with.
            edgeSnapGapDegrees={PAIR_EDGE_SNAP_GAP_DEG}
            // „Taste A und X für Play/Pause. Taste B dann zum Neuzentrieren."
            // The right controller has exactly two face buttons, and the
            // library's default binds A to a hold-to-recenter — so taking A for
            // play/pause (see <XRPlayerControls>) means one press would
            // otherwise do BOTH. sphere-shell 0.3.0 added this prop for exactly
            // this collision; recentering keeps its ~1 s hold on B, which is
            // the library's deliberate guard against a brushed thumb throwing
            // the whole shell to a new position and yaw.
            recenterButton="b-button"
            // The background row - see `chooseBackgroundRow`'s doc comment.
            // Present in BOTH modes (browse and player), unlike
            // `dockControls` below: the dock's three-dot menu exists
            // regardless of mode, and the background choice is meaningful in
            // either one (a viewer can switch it while still browsing, before
            // any episode is open).
            dockMenuItems={dockMenuItems}
            // Player mode only ("Browse mode shows no transport", Task 13's
            // brief) - undefined rather than an empty fragment while
            // browsing, so the dock renders its own default
            // Arrange/Recenter/Exit-VR buttons with no app slot beside them.
            dockControls={
              mode === 'player' ? (
                <DockTransport
                  store={playerStore}
                  seriesStore={seriesStore}
                  tour={
                    tour.active
                      ? {
                          step: TOUR_STEPS[tour.stepIndex]!,
                          stepNumber: tour.stepIndex + 1,
                          stepCount: TOUR_STEPS.length,
                          isLast: isLastTourStep(tour, TOUR_STEPS.length),
                          onAdvance: advanceTour,
                          onSkip: skipTour,
                        }
                      : undefined
                  }
                />
              ) : undefined
            }
          >
            {mode === 'browse' ? (
              <LibraryWindow store={playerStore} />
            ) : (
              <>
                <VideoWindows store={playerStore} />
                <ControlsWindow store={playerStore} />
                {/* Both self-gate on the open episode's own data (segments.length
                    > 0 / seriesId != null) and render nothing otherwise - same
                    "always mount, defensively bail" idiom ControlsWindow uses for
                    the (structurally impossible, but still checked) missing-episode
                    case. */}
                <ChaptersWindow store={playerStore} />
                <SeriesWindow store={playerStore} seriesStore={seriesStore} />
                <TranscriptWindow store={playerStore} />
              </>
            )}
          </WindowShell>
          {/* NOT inside <WindowShell> - a <HeadLocked> is not a window (see
              SubtitleHud.tsx's own doc comment and sphere-shell's HeadLocked.tsx
              doc comment: "mount it anywhere alongside <WindowShell>"). Renders
              nothing itself while browsing (its own self-gate: no cues, no
              seek preview outside player mode). */}
          {mode === 'player' && <SubtitleHud store={playerStore} />}
          {/* Also not a window, and for the same reason: it renders nothing at
              all - it is a useFrame reading the controllers (left stick =
              seek/chapters, A/X = play/pause). Inside <XR> because that is
              where the input-source store lives, outside <WindowShell> because
              it is the app's own input, not the shell's. Player mode only:
              there is nothing to seek or pause while browsing. */}
          {mode === 'player' && <XRPlayerControls store={playerStore} />}
        </XR>
      </Canvas>
    </div>
  )
}
