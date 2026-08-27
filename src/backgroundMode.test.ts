import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BACKGROUND,
  availableBackground,
  backgroundColorFor,
  backgroundToggleAvailable,
  backgroundToggleLabel,
  otherBackground,
  sessionModeFor,
} from './backgroundMode'

describe('sessionModeFor', () => {
  it('maps passthrough to immersive-ar, the only mode a Quest blends the room into', () => {
    expect(sessionModeFor('passthrough')).toBe('immersive-ar')
  })
  it('maps black to immersive-vr, whose blend mode is opaque', () => {
    expect(sessionModeFor('black')).toBe('immersive-vr')
  })
})

describe('backgroundColorFor', () => {
  it("keeps the player's established near-black for the opaque choice", () => {
    expect(backgroundColorFor('black')).toBe('#101014')
  })
  it('renders NO background for passthrough - a set background paints over the camera feed', () => {
    expect(backgroundColorFor('passthrough')).toBe(null)
  })
})

describe('DEFAULT_BACKGROUND', () => {
  it('is black, i.e. unchanged from the pre-existing hard-coded behaviour', () => {
    expect(DEFAULT_BACKGROUND).toBe('black')
  })
})

describe('availableBackground', () => {
  it('honours black regardless of AR support - it is always enterable', () => {
    expect(availableBackground('black', true)).toBe('black')
    expect(availableBackground('black', false)).toBe('black')
  })

  it('honours passthrough when the device actually supports immersive-ar', () => {
    expect(availableBackground('passthrough', true)).toBe('passthrough')
  })

  it('falls back to black for passthrough on a device with no immersive-ar support', () => {
    // A stored preference from a different device/browser, or a radio
    // rendered before isSessionSupported resolves - either way the overlay
    // must never hand xrStore.enterAR() a mode it will only reject.
    expect(availableBackground('passthrough', false)).toBe('black')
  })
})

describe('otherBackground', () => {
  it('flips black to passthrough and back', () => {
    expect(otherBackground('black')).toBe('passthrough')
    expect(otherBackground('passthrough')).toBe('black')
  })
})

describe('backgroundToggleAvailable', () => {
  it('is always true switching FROM passthrough (the target is black, always enterable)', () => {
    expect(backgroundToggleAvailable('passthrough', true)).toBe(true)
    expect(backgroundToggleAvailable('passthrough', false)).toBe(true)
  })

  it('is true switching FROM black when the device supports immersive-ar', () => {
    expect(backgroundToggleAvailable('black', true)).toBe(true)
  })

  it('is false switching FROM black when the device has no immersive-ar support - the one case the row must hide for', () => {
    expect(backgroundToggleAvailable('black', false)).toBe(false)
  })
})

describe('backgroundToggleLabel', () => {
  it('names the SWITCH TARGET, not the current state', () => {
    expect(backgroundToggleLabel('black')).toBe('Hintergrund: Durchsichtig')
    expect(backgroundToggleLabel('passthrough')).toBe('Hintergrund: Schwarz')
  })
})
