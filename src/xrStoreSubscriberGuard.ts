/**
 * Wraps an `xrStore.subscribe` callback body so it can never throw out of
 * `xrStore`'s own notification loop.
 *
 * ## The hazard this closes
 *
 * `xrStore` (built by `@pmndrs/xr`'s `createXRStore`, on top of
 * `zustand/vanilla`'s `createStore`) notifies every subscriber SYNCHRONOUSLY
 * from inside `setState`:
 *
 * ```js
 * // node_modules/.pnpm/zustand@4.5.7.../zustand/esm/vanilla.mjs (@pmndrs/xr's
 * // own dependency - the exact store `xrStore` is built from) and, separately,
 * // zustand@5.0.x (this app's own direct dependency) - identical in both:
 * listeners.forEach((listener) => listener(state, previousState))
 * ```
 *
 * `Set.prototype.forEach` has no exception isolation: if one listener throws,
 * `forEach` aborts immediately and every listener registered AFTER it (in
 * insertion order) is simply never called for that notification - the
 * exception propagates straight out of `setState` itself. Verified directly
 * against both installed `vanilla.mjs` files; this is not speculative.
 *
 * `xrStore.subscribe` is called from three places reachable from this app:
 * `App.tsx`'s tour-gate effect and its telemetry effect (both wrapped by this
 * function), plus every `useXRSession()` call inside `sphere-shell` -
 * including `DockTransport`'s own (`windows/DockTransport.tsx`), which mounts
 * fresh every time player mode is entered (`App.tsx`'s `mode === 'player'`
 * dock-controls gate) and is therefore ALWAYS added to `xrStore`'s listener
 * set AFTER `App.tsx`'s two subscribers, which are registered once at
 * `<App>`'s own mount and never torn down for the lifetime of the page. A
 * throw from either of `App.tsx`'s subscribers would therefore silently cut
 * `DockTransport`'s own session-state sync out of the SAME notification that
 * just ended (or started) the WebXR session - exactly the shape of failure a
 * viewer would experience as "exiting VR doesn't finish", even though the
 * WebXR session itself ended correctly at the API level.
 *
 * No specific throw site was found in either of `App.tsx`'s subscriber
 * bodies as of this fix - this is deliberate defense-in-depth for a PROVEN
 * structural hazard (a subscriber must never be able to break another
 * consumer's notification), not a patch for one traced exception. See
 * `xrStoreSubscriberGuard.test.ts` for a runnable reproduction of the hazard
 * itself, against a real zustand vanilla store, both with and without this
 * guard.
 *
 * `console.error` rather than fully silent: an exception here is always a
 * real bug (unlike `telemetry.ts`'s deliberately-silent transport failures,
 * which are an EXPECTED "no counter deployed" case) - it should be visible in
 * devtools, just never allowed to reach `xrStore`'s own notification loop.
 */
export function guardXRStoreSubscriber(label: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`xrStore subscriber (${label}) threw - swallowed to protect other subscribers`, error)
  }
}
