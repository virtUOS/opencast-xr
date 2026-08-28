/**
 * The player's half of the anonymous visitor counter (see `counter/README.md`
 * for the service this talks to). Sends at most three beacons per page load:
 *
 *   - `{"kind": "page"}` once, on load.
 *   - `{"kind": "vr"}` the first time this page load enters an
 *     `immersive-vr` session.
 *   - `{"kind": "ar"}` the first time this page load enters an
 *     `immersive-ar` session.
 *
 * Re-entering VR or AR later in the SAME page load sends nothing more - see
 * `shouldSendHit` below. This is a deliberate choice, not an oversight: the
 * counter answers "was this page view ever seen in a headset", not "how many
 * times did this visitor enter and exit a session" - the latter would need a
 * session-scoped identifier this design specifically avoids introducing.
 *
 * ## Why this is split into pure decision logic + a thin transport
 *
 * `shouldSendHit`/`hitPayload` are pure (no network, no globals) so the
 * "send at most once per kind, with this exact payload" behaviour is fully
 * unit-testable. `reportHit` adds the one impure step (calling a transport
 * function) but still takes that transport as a parameter, so tests can
 * inject a recording fake instead of touching `navigator.sendBeacon`/`fetch`.
 * Only `reportHit`'s default transport and the `import.meta.env.DEV` guard at
 * the call sites in `App.tsx` are wiring that has to run for real.
 *
 * ## Why failure is always silent
 *
 * A deployment with no counter service behind it (no `/api/hit` route at
 * all - see the install guide: the counter is DOCUMENTED, not required) must
 * behave EXACTLY like one with it: no console noise, no retry, no effect on
 * playback. `reportHit` therefore swallows anything the transport throws or
 * rejects with, and the default transport itself never lets a network
 * failure surface as an unhandled rejection.
 */

export type HitKind = 'page' | 'vr' | 'ar'

/** Same-origin, relative on purpose - see `counter/README.md`: this avoids
 * CORS entirely (the beacon only ever talks to whatever origin is serving
 * the player itself, which is exactly where Caddy's `handle /api/hit`
 * reverse-proxies to the counter service - see the install guide). */
const HIT_ENDPOINT = '/api/hit'

/** Tracks which kinds have already been sent THIS page load. One instance
 * lives for the lifetime of the page (see the module-level singleton at the
 * bottom) - reloading the page is a new page load and gets a fresh one. */
export interface TelemetryState {
  sent: Set<HitKind>
}

export function createTelemetryState(): TelemetryState {
  return { sent: new Set() }
}

/**
 * Whether a hit of `kind` should be sent given what has already been sent
 * this page load - true (and records `kind` as sent) the first time for each
 * kind, false every time after. Pure: no I/O, just a `Set` mutation local to
 * the `state` object passed in.
 */
export function shouldSendHit(state: TelemetryState, kind: HitKind): boolean {
  if (state.sent.has(kind)) return false
  state.sent.add(kind)
  return true
}

/** The exact wire payload for a hit of `kind` - matches
 * `counter/src/validate.js`'s strict `{"kind": ...}`-only shape precisely:
 * no extra fields, so the counter never has a reason to reject it. */
export function hitPayload(kind: HitKind): string {
  return JSON.stringify({ kind })
}

/** How a hit actually leaves the browser - swappable for tests. */
export type HitTransport = (body: string) => void

function defaultTransport(body: string): void {
  // navigator.sendBeacon is preferred: it's fire-and-forget, survives the
  // page unloading (relevant for the 'page' hit racing an immediate
  // navigation away), and needs no response handling. It can return false
  // (queue full, or unsupported) without throwing, in which case fetch with
  // `keepalive: true` (the same "survive unload" property) is the fallback.
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' })
    if (navigator.sendBeacon(HIT_ENDPOINT, blob)) return
  }
  if (typeof fetch === 'function') {
    void fetch(HIT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Silent - see module doc comment: a missing/unreachable counter must
      // not be visible to the viewer in any way.
    })
  }
}

/**
 * Sends a hit of `kind` via `transport`, but only if `shouldSendHit` says
 * this kind hasn't already gone out this page load. Never throws, no matter
 * what `transport` does - see the module doc comment.
 */
export function reportHit(state: TelemetryState, kind: HitKind, transport: HitTransport = defaultTransport): void {
  if (!shouldSendHit(state, kind)) return
  try {
    transport(hitPayload(kind))
  } catch {
    // Silent - see module doc comment.
  }
}

/**
 * The one instance `App.tsx` uses - a module-level singleton rather than
 * something re-created per component mount, so "once per page load" holds
 * even across whatever remounts React itself might do (StrictMode's
 * deliberate double-invoke in dev is moot here anyway: dev builds never call
 * `reportHit` at all - see `App.tsx`'s `import.meta.env.DEV` guards).
 */
const pageLoadTelemetry = createTelemetryState()

/** Thin entry point for `App.tsx`: reports `kind` exactly once for the
 * lifetime of this module (i.e. this page load), via the real transport. */
export function reportPageLoadHit(kind: HitKind): void {
  reportHit(pageLoadTelemetry, kind)
}
