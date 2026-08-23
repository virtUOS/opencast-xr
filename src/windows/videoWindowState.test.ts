import { describe, expect, it } from 'vitest'
import {
  MAIN_AZIMUTH_DEG,
  MAIN_WIDTH_DEG,
  SIDE_AZIMUTH_DEG,
  SIDE_ROW_GAP_DEG,
  SIDE_WIDTH_DEG,
  VIDEO_ASPECT,
  streamWindowAction,
  videoWindowId,
  videoWindowPlacement,
  type StreamWindowSyncInput,
} from './videoWindowState'

describe('videoWindowId', () => {
  it('is `video-` + flavorType', () => {
    expect(videoWindowId('presenter')).toBe('video-presenter')
    expect(videoWindowId('presentation')).toBe('video-presentation')
  })
})

describe('videoWindowPlacement', () => {
  it('puts the first two streams at +-24 deg, 40 deg wide, on the horizon', () => {
    expect(videoWindowPlacement(0)).toEqual({
      size: { width: MAIN_WIDTH_DEG, height: MAIN_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: -MAIN_AZIMUTH_DEG, elevation: 0 },
    })
    expect(videoWindowPlacement(1)).toEqual({
      size: { width: MAIN_WIDTH_DEG, height: MAIN_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: MAIN_AZIMUTH_DEG, elevation: 0 },
    })
  })

  it('puts the third and fourth streams at +-55 deg, 24 deg wide, on the horizon', () => {
    expect(videoWindowPlacement(2).size).toEqual({
      width: SIDE_WIDTH_DEG,
      height: SIDE_WIDTH_DEG / VIDEO_ASPECT,
    })
    expect(videoWindowPlacement(2).position).toEqual({ azimuth: -SIDE_AZIMUTH_DEG, elevation: 0 })
    expect(videoWindowPlacement(3).position).toEqual({ azimuth: SIDE_AZIMUTH_DEG, elevation: 0 })
  })

  it('stacks further flank pairs downward instead of widening the arc', () => {
    const row1 = videoWindowPlacement(4)
    expect(row1.position.azimuth).toBe(-SIDE_AZIMUTH_DEG)
    expect(row1.position.elevation).toBeLessThan(0)
    // One full window height plus the gap below its own row-0 neighbour.
    expect(row1.position.elevation).toBeCloseTo(
      -(SIDE_WIDTH_DEG / VIDEO_ASPECT + SIDE_ROW_GAP_DEG), 10,
    )
    expect(videoWindowPlacement(5).position).toEqual({
      azimuth: SIDE_AZIMUTH_DEG,
      elevation: row1.position.elevation,
    })
    expect(videoWindowPlacement(6).position.elevation).toBeCloseTo(2 * row1.position.elevation, 10)
  })

  it('keeps every window inside the shell default bounds up to six streams', () => {
    for (let i = 0; i < 6; i++) {
      const { position } = videoWindowPlacement(i)
      expect(Math.abs(position.azimuth)).toBeLessThanOrEqual(110)
      expect(position.elevation).toBeGreaterThanOrEqual(-40)
      expect(position.elevation).toBeLessThanOrEqual(60)
    }
  })
})

describe('streamWindowAction', () => {
  const shellOpen = { closed: false, minimized: false }
  const shellClosed = { closed: true, minimized: false }

  function act(overrides: Partial<StreamWindowSyncInput> = {}): string {
    return streamWindowAction({ shell: shellOpen, streamOpen: true, canClose: true, ...overrides })
  }

  it('does nothing while the shell entry does not exist yet (first render)', () => {
    expect(act({ shell: undefined })).toBe('none')
    // ...not even when the stream is closed - a missing entry must not look
    // like "the shell restored it" either.
    expect(act({ shell: undefined, streamOpen: false })).toBe('none')
  })

  it('does nothing for a flavor that has no stream at all', () => {
    expect(act({ streamOpen: undefined })).toBe('none')
    expect(act({ shell: shellClosed, streamOpen: undefined })).toBe('none')
  })

  it('does nothing while the two states agree', () => {
    expect(act({ shell: shellOpen, streamOpen: true })).toBe('none')
    expect(act({ shell: shellClosed, streamOpen: false })).toBe('none')
  })

  it('unloads the stream when the shell window was closed', () => {
    expect(act({ shell: shellClosed, streamOpen: true })).toBe('close-stream')
  })

  it('refuses to unload the last open stream and undoes the shell close instead', () => {
    expect(act({ shell: shellClosed, streamOpen: true, canClose: false })).toBe('veto-close')
  })

  it('reopens the stream when the shell window came back (dock restore)', () => {
    expect(act({ shell: shellOpen, streamOpen: false })).toBe('reopen-stream')
  })

  it('reopens even when canClose is false - closing is gated, restoring is not', () => {
    expect(act({ shell: shellOpen, streamOpen: false, canClose: false })).toBe('reopen-stream')
  })

  it('treats MINIMIZED as no change at all: minimizing never unloads a stream', () => {
    expect(act({ shell: { closed: false, minimized: true }, streamOpen: true })).toBe('none')
    expect(act({ shell: { closed: false, minimized: true }, streamOpen: true, canClose: false }))
      .toBe('none')
  })

  it('still closes a window that was minimized and THEN closed', () => {
    // The shell allows both flags at once (dock.ts: "closed wins over
    // minimized"), and that combination IS a close.
    expect(act({ shell: { closed: true, minimized: true }, streamOpen: true })).toBe('close-stream')
  })

  it('reopens a stream whose window is restored straight out of a minimized close', () => {
    // restoreWindow clears both flags, so this is the state right after a dock
    // click on such a tile.
    expect(act({ shell: { closed: false, minimized: false }, streamOpen: false })).toBe('reopen-stream')
  })
})
