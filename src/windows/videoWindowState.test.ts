import { describe, expect, it } from 'vitest'
import {
  MAIN_AZIMUTH_DEG,
  MAIN_WIDTH_DEG,
  SIDE_AZIMUTH_DEG,
  SIDE_ROW_GAP_DEG,
  SIDE_WIDTH_DEG,
  VIDEO_ASPECT,
  streamErrorEscapeHint,
  streamWindowAction,
  videoWindowId,
  videoWindowPlacement,
  PAIR_AZIMUTH_DEG,
  PAIR_WIDTH_DEG,
  SOLO_WIDTH_DEG,
  type StreamWindowSyncInput,
} from './videoWindowState'

describe('videoWindowId', () => {
  it('is `video-` + flavorType', () => {
    expect(videoWindowId('presenter')).toBe('video-presenter')
    expect(videoWindowId('presentation')).toBe('video-presentation')
  })
})

describe('streamErrorEscapeHint', () => {
  it('names the way out for the last open stream, whose window cannot be closed', () => {
    const hint = streamErrorEscapeHint(false)
    expect(hint).not.toBeNull()
    // The escape has to be NAMED, not implied: with the X vetoed and the
    // reload button re-failing against the same URL, the dock's "Home" crumb
    // is the only control that gets the user out of a permanently dead
    // single-stream episode.
    expect(hint).toContain('Home')
    // ...and it must name a control that still EXISTS. The dock UX round
    // replaced the old "Bibliothek" button with the breadcrumb's Home crumb,
    // and this string went stale pointing at it - in the user's only way out
    // of a dead stream. Asserted as an absence so the same drift fails loudly
    // next time rather than shipping.
    expect(hint).not.toContain('Bibliothek')
  })

  it('says nothing when another stream is still up', () => {
    // The X works and the rest of the wall keeps playing - no dead end to explain.
    expect(streamErrorEscapeHint(true)).toBeNull()
  })

  it('sticks to glyphs uikit 1.0.74 default font can draw', () => {
    // Same constraint as LibraryWindow's BACK_LABEL: diacritics render, but
    // typographic punctuation comes out as tofu boxes.
    expect(streamErrorEscapeHint(false)).not.toMatch(/[‹›„“”…·—]/)
  })
})

describe('videoWindowPlacement', () => {
  it('gives a lone stream the whole comfortable arc, centred', () => {
    // „Am Start nur die Videofenster einblenden und das moeglichst gross" -
    // and one stream is the normal case for a real Opencast recording.
    expect(videoWindowPlacement(0, 1)).toEqual({
      size: { width: SOLO_WIDTH_DEG, height: SOLO_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: 0, elevation: 0 },
    })
  })

  it('gives a PAIR as much width as fits without leaving the comfortable arc', () => {
    expect(videoWindowPlacement(0, 2)).toEqual({
      size: { width: PAIR_WIDTH_DEG, height: PAIR_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: -PAIR_AZIMUTH_DEG, elevation: 0 },
    })
    expect(videoWindowPlacement(1, 2)).toEqual({
      size: { width: PAIR_WIDTH_DEG, height: PAIR_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: PAIR_AZIMUTH_DEG, elevation: 0 },
    })
  })

  it('is bigger than it used to be - that is the whole point of the round', () => {
    // The regression guard for the directive: a later edit that quietly puts
    // one or two streams back at the old 40 degrees fails here.
    expect(videoWindowPlacement(0, 1).size.width).toBeGreaterThan(MAIN_WIDTH_DEG)
    expect(videoWindowPlacement(0, 2).size.width).toBeGreaterThan(MAIN_WIDTH_DEG)
  })

  it('keeps one and two streams inside the +-55 deg comfortable arc', () => {
    // Wider than this needs a head turn to read, which is the constraint the
    // sizes were derived from (a Quest 3 sees about 110 degrees at once).
    for (const [index, count] of [[0, 1], [0, 2], [1, 2]] as const) {
      const { size, position } = videoWindowPlacement(index, count)
      expect(Math.abs(position.azimuth) + size.width / 2).toBeLessThanOrEqual(55)
    }
  })

  it('keeps one and two streams clear of the dock at -30 deg', () => {
    for (const [index, count] of [[0, 1], [0, 2], [1, 2]] as const) {
      const { size, position } = videoWindowPlacement(index, count)
      expect(position.elevation - size.height / 2).toBeGreaterThan(-26)
    }
  })

  it('leaves the two main windows at their old +-24 deg once a THIRD stream exists', () => {
    // With a flank pair already out at +-55 there is no width left to give.
    expect(videoWindowPlacement(0, 3)).toEqual({
      size: { width: MAIN_WIDTH_DEG, height: MAIN_WIDTH_DEG / VIDEO_ASPECT },
      position: { azimuth: -MAIN_AZIMUTH_DEG, elevation: 0 },
    })
    expect(videoWindowPlacement(1, 3).position).toEqual({ azimuth: MAIN_AZIMUTH_DEG, elevation: 0 })
  })

  it('puts the third and fourth streams at +-55 deg, 24 deg wide, on the horizon', () => {
    expect(videoWindowPlacement(2, 4).size).toEqual({
      width: SIDE_WIDTH_DEG,
      height: SIDE_WIDTH_DEG / VIDEO_ASPECT,
    })
    expect(videoWindowPlacement(2, 4).position).toEqual({ azimuth: -SIDE_AZIMUTH_DEG, elevation: 0 })
    expect(videoWindowPlacement(3, 4).position).toEqual({ azimuth: SIDE_AZIMUTH_DEG, elevation: 0 })
  })

  it('stacks further flank pairs downward instead of widening the arc', () => {
    const row1 = videoWindowPlacement(4, 6)
    expect(row1.position.azimuth).toBe(-SIDE_AZIMUTH_DEG)
    expect(row1.position.elevation).toBeLessThan(0)
    // One full window height plus the gap below its own row-0 neighbour.
    expect(row1.position.elevation).toBeCloseTo(
      -(SIDE_WIDTH_DEG / VIDEO_ASPECT + SIDE_ROW_GAP_DEG), 10,
    )
    expect(videoWindowPlacement(5, 6).position).toEqual({
      azimuth: SIDE_AZIMUTH_DEG,
      elevation: row1.position.elevation,
    })
    expect(videoWindowPlacement(6, 8).position.elevation).toBeCloseTo(2 * row1.position.elevation, 10)
  })

  it('keeps every window inside the shell default bounds up to six streams', () => {
    for (let i = 0; i < 6; i++) {
      const { position } = videoWindowPlacement(i, 6)
      expect(Math.abs(position.azimuth)).toBeLessThanOrEqual(110)
      expect(position.elevation).toBeGreaterThanOrEqual(-40)
      expect(position.elevation).toBeLessThanOrEqual(60)
    }
  })

  it('never sizes a window as if it were alone when its own index says otherwise', () => {
    // A caller mid-swap (or a defensive 0) must not hand stream 1 the solo
    // layout, which would stack two windows on top of each other at azimuth 0.
    expect(videoWindowPlacement(1, 0).position.azimuth).not.toBe(0)
    expect(videoWindowPlacement(1, 1)).toEqual(videoWindowPlacement(1, 2))
  })
})

describe('streamWindowAction', () => {
  const shellOpen = { closed: false, minimized: false }
  const shellClosed = { closed: true, minimized: false }

  function act(overrides: Partial<StreamWindowSyncInput> = {}): string {
    return streamWindowAction({
      shell: shellOpen, streamOpen: true, canClose: true, episodeChanged: false, ...overrides,
    })
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

  describe('episode swap (stale shell flag trap)', () => {
    it('does NOT unload a fresh episode\'s stream whose window was closed in the previous one', () => {
      // The trap: openEpisode rebuilds `streams` with open: true but cannot
      // touch the shell, so the closed flag is left over from episode A. With
      // two streams `canClose` is true, so the normal rule would have unloaded
      // this one on arrival - and stayed unloaded.
      expect(act({ shell: shellClosed, streamOpen: true, canClose: true, episodeChanged: true }))
        .toBe('reset-window')
    })

    it('clears a leftover MINIMIZED flag too - a new recording starts with its windows up', () => {
      expect(act({ shell: { closed: false, minimized: true }, episodeChanged: true }))
        .toBe('reset-window')
    })

    it('does nothing on a swap whose window state is already clean', () => {
      expect(act({ shell: shellOpen, streamOpen: true, episodeChanged: true })).toBe('none')
    })

    it('does not reopen on the swap round: the reset comes first, rules follow after', () => {
      // A stream that is somehow closed in the store on the swap round must not
      // be reopened by this evaluation - the shell flag is the untrustworthy
      // half, so nothing but the reset may happen until it has been cleared.
      expect(act({ shell: shellClosed, streamOpen: false, episodeChanged: true })).toBe('reset-window')
      expect(act({ shell: shellOpen, streamOpen: false, episodeChanged: true })).toBe('none')
    })

    it('is inert before the window is registered', () => {
      expect(act({ shell: undefined, episodeChanged: true })).toBe('none')
    })

    it('resumes normal rules on the evaluation after the reset', () => {
      // Two-step: reset clears the flag (shell entry becomes open), and the
      // next round - no longer an episode change - agrees with the store.
      expect(act({ shell: shellClosed, streamOpen: true, episodeChanged: true })).toBe('reset-window')
      expect(act({ shell: shellOpen, streamOpen: true, episodeChanged: false })).toBe('none')
    })
  })

  // These encode the "cannot loop" invariant the implementation relies on:
  // every action makes the two states agree, so the FOLLOW-UP evaluation is
  // always 'none'. A comment cannot fail when someone changes a rule.
  describe('two-step sequences settle', () => {
    it('veto-close then restore settles: no oscillation', () => {
      expect(act({ shell: shellClosed, streamOpen: true, canClose: false })).toBe('veto-close')
      // ...the hook called shellStore.restore(id), so the entry is open again
      // while the stream never closed:
      expect(act({ shell: shellOpen, streamOpen: true, canClose: false })).toBe('none')
    })

    it('close-stream then the closed state settles', () => {
      expect(act({ shell: shellClosed, streamOpen: true, canClose: true })).toBe('close-stream')
      // canClose flips to true-for-a-closed-stream (see the store: a stream
      // that is not open is never "the last open stream"), and the two agree:
      expect(act({ shell: shellClosed, streamOpen: false })).toBe('none')
    })

    it('reopen-stream then the open state settles', () => {
      expect(act({ shell: shellOpen, streamOpen: false })).toBe('reopen-stream')
      expect(act({ shell: shellOpen, streamOpen: true })).toBe('none')
    })

    it('an unmount as the second step is inert, whatever the first step was', () => {
      // The window unregisters (mode change, episode swap dropping this flavor,
      // shell teardown) between the two evaluations. The entry is gone while
      // the store still says open - which must NOT read as "the shell closed
      // it", or teardown would unload streams behind the store's back.
      expect(act({ shell: shellClosed, streamOpen: true, canClose: false })).toBe('veto-close')
      expect(act({ shell: undefined, streamOpen: true, canClose: false })).toBe('none')
      expect(act({ shell: shellClosed, streamOpen: true })).toBe('close-stream')
      expect(act({ shell: undefined, streamOpen: false })).toBe('none')
    })
  })
})
