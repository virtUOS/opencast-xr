/**
 * The ONLY surface the sync engine sees. `HTMLVideoElement` satisfies this
 * structurally, so the engine works against real `<video>` elements without
 * ever importing them - and tests can drive a plain fake through the exact
 * same interface with no DOM, no timers, and no browser.
 */
export interface VideoLike {
  currentTime: number
  playbackRate: number
  muted: boolean
  volume: number
  readonly paused: boolean
  /** 0..4, matching HTMLMediaElement.readyState; HAVE_FUTURE_DATA = 3 is the stall threshold. */
  readonly readyState: number
  play(): Promise<void> | void
  pause(): void
}
