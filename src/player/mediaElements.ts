/**
 * The ONLY place an Opencast stream's `HTMLVideoElement` is created or torn
 * down. Every other module (the store, and eventually the video window
 * component) goes through here rather than calling `document.createElement`
 * itself, so the DOM-attach rule below is stated once.
 */

/**
 * Creates a muted, autoplay-eligible `<video>` for one stream and attaches it
 * to `document.body` with a near-invisible (but on-screen) style.
 *
 * Deliberately NOT display:none / off-viewport: Chrome (and likely other
 * browsers) auto-pauses muted/no-audio "video-only" elements that are not
 * visible on screen, to save power - this applies even to elements that are
 * never inserted into the DOM at all, which is exactly what a naive app-side
 * video element (created only to feed a texture/canvas) looks like. Keeping a
 * near-invisible but on-screen DOM presence is what keeps real playback from
 * being silently paused mid-stream. See https://goo.gl/LdLk22. (Copied from
 * the demo's `useVideo`, where this was a real bug found in Task 13.)
 */
export function createStreamElement(url: string): HTMLVideoElement {
  const v = document.createElement('video')
  v.src = url
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'

  v.style.position = 'fixed'
  v.style.left = '0'
  v.style.top = '0'
  v.style.width = '2px'
  v.style.height = '2px'
  v.style.opacity = '0.01'
  v.style.pointerEvents = 'none'

  document.body.appendChild(v)
  return v
}

/**
 * The spec's "really unload": pauses, drops the `src` attribute, calls
 * `load()` (the standard way to make a `<video>` release its network/decoder
 * resources instead of just hiding a paused element), then removes it from
 * the DOM. Safe to call on an element that was never attached.
 */
export function destroyStreamElement(v: HTMLVideoElement): void {
  v.pause()
  v.removeAttribute('src')
  v.load()
  v.remove()
}
