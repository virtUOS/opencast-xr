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

/**
 * How much of `MediaError.message` the returned line is allowed to carry.
 *
 * Chrome's messages can be long and internal
 * ("DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed"), and
 * this string is rendered by a uikit `<Text>` inside a video window - where
 * @react-three/uikit 1.0.74's many-wrapped-lines defect makes a paragraph a
 * rendering risk (see docs/UIKIT-NOTES.md). Capping keeps the tile to one or
 * two short lines while still naming the concrete cause, which is the whole
 * point of showing it: inside a headset there is no console to read.
 */
const ERROR_DETAIL_MAX_CHARS = 44

/**
 * One short German line naming what a stream element's `error` event actually
 * was - the text of the spec §9 error tile.
 *
 * `code` is the only machine-readable part of a `MediaError` (`message` is
 * implementation-defined and empty in some browsers), so it drives the
 * wording; the message is appended, capped, when there is one. Numeric
 * literals rather than the `MediaError.MEDIA_ERR_*` constants because those
 * live on a DOM interface object that need not exist in every test
 * environment, while the code values are fixed by the HTML spec.
 *
 * `null`/`undefined` is a real case, not just defensiveness: an `error` event
 * whose `element.error` has already been cleared (a `load()` racing the
 * dispatch) still has to produce a sentence.
 */
export function describeMediaError(err: MediaError | null | undefined): string {
  const raw = err?.message ?? ''
  const detail =
    raw.length === 0
      ? ''
      : ` (${raw.length > ERROR_DETAIL_MAX_CHARS ? `${raw.slice(0, ERROR_DETAIL_MAX_CHARS - 3)}...` : raw})`
  switch (err?.code) {
    case 1: // MEDIA_ERR_ABORTED
      return `Laden abgebrochen${detail}`
    case 2: // MEDIA_ERR_NETWORK
      return `Netzwerkfehler im Stream${detail}`
    case 3: // MEDIA_ERR_DECODE
      return `Stream nicht dekodierbar${detail}`
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return `Stream nicht erreichbar oder nicht unterstützt${detail}`
    default:
      return `Unbekannter Stream-Fehler${detail}`
  }
}
