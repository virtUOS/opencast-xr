/**
 * jsdom implements `HTMLMediaElement.prototype.play/pause/load` as
 * deliberate "not implemented" stubs: each one logs a console.error and does
 * nothing else - `paused` never actually flips, no matter how many times
 * `play()`/`pause()` are called. That's a reasonable scope limit for jsdom
 * (it doesn't decode video), but it silently defeats any test whose
 * assertions depend on real play/pause semantics - `SyncEngine`'s stall and
 * audio bookkeeping key off `video.paused` - and it drowns test output in
 * dozens of irrelevant stack traces per run, which is exactly the kind of
 * noise that can hide a real failure.
 *
 * This gives every `HTMLMediaElement` in the test environment (registered as
 * vitest's `setupFiles`, so it runs once per test file before any test
 * touches the DOM) a real, minimal `paused` flag: `play()` resolves and
 * flips it to `false`, `pause()` flips it to `true` synchronously - matching
 * what a real `<video>` does - and `load()` is a no-op (there's nothing
 * actually loaded in jsdom to reset).
 */
const pausedByElement = new WeakMap<HTMLMediaElement, boolean>()

Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get(this: HTMLMediaElement) {
    return pausedByElement.get(this) ?? true
  },
})

HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
  pausedByElement.set(this, false)
  return Promise.resolve()
}

HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
  pausedByElement.set(this, true)
}

HTMLMediaElement.prototype.load = function load() {
  // No-op: nothing is actually loaded in jsdom to reset.
}
