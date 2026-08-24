import { describe, expect, it } from 'vitest'
import { PANEL_WINDOW_IDS, panelToggleAction } from './panelWindows'

describe('PANEL_WINDOW_IDS', () => {
  it('names the four panel windows', () => {
    expect(Object.keys(PANEL_WINDOW_IDS).sort()).toEqual(['chapters', 'info', 'series', 'transcript'])
  })

  it('keeps the Info window\'s id as „controls"', () => {
    // The window was renamed „Info" in the previous round but its shell id was
    // deliberately left alone: the id is what a saved layout refers to, so
    // renaming it would silently drop the saved position of anyone who had one.
    // A later tidy-up that "fixes" the name has to fail here first.
    expect(PANEL_WINDOW_IDS.info).toBe('controls')
  })

  it('has no id in common with a video window', () => {
    // Video windows are `video-<flavorType>` (videoWindowState.ts). A collision
    // would make a panel button close somebody's video.
    for (const id of Object.values(PANEL_WINDOW_IDS)) {
      expect(id.startsWith('video-')).toBe(false)
    }
  })
})

describe('panelToggleAction', () => {
  it('closes a panel that is on screen', () => {
    expect(panelToggleAction({ closed: false, minimized: false })).toBe('close')
  })

  it('restores a panel that is closed', () => {
    expect(panelToggleAction({ closed: true, minimized: false })).toBe('restore')
  })

  it('restores a MINIMIZED panel rather than closing it', () => {
    // Both hidden states are the same request from where the user is standing:
    // they pressed „Reihe" because they want to see the series. `restore`
    // clears both flags, so this is one press, not two.
    expect(panelToggleAction({ closed: false, minimized: true })).toBe('restore')
    expect(panelToggleAction({ closed: true, minimized: true })).toBe('restore')
  })

  it('restores when the window is not registered at all', () => {
    // Gated off by its own data, or not mounted yet. Both answers are no-ops
    // against the store, but „close" would make the first press of a button
    // silently do nothing and the second one work - which reads as broken
    // hit-testing, not as a no-op.
    expect(panelToggleAction(undefined)).toBe('restore')
  })

  it('round-trips: whatever it does, doing it makes the next answer the other one', () => {
    const open = { closed: false, minimized: false }
    const closed = { closed: true, minimized: false }
    expect(panelToggleAction(open)).toBe('close')
    expect(panelToggleAction(closed)).toBe('restore')
  })
})
