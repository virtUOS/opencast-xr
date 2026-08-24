// @vitest-environment jsdom
//
// `useStartClosed` against a REAL sphere-shell window store.
//
// The decision this hook makes is three lines long; the bug it has already had
// was not in those lines but in how the ref guarding them interacts with a
// window REGISTERING and UNREGISTERING over an episode change (code review,
// I3). A pure-function extraction would have modelled the lines and missed the
// interaction, so this drives the actual hook: a probe component inside a real
// `<ShellProvider>` over a real `createWindowStore()`, with the registrations
// written the way sphere-shell's own `<Window>` writes them.
//
// Rendered with React's own `act` + `createRoot` rather than
// `@testing-library/react` - this app does not depend on it, and the harness
// that replaces it is fifteen lines. Nothing here needs a WebGL context: the
// shell store, `ShellProvider` and `useWindowState` are all plain React and
// zustand.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ShellProvider, createWindowStore, type WindowStore } from 'sphere-shell'
import { PANEL_WINDOW_IDS } from './panelWindows'
import { useStartClosed } from './useStartClosed'

// React 19 refuses to run `act` without this.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = PANEL_WINDOW_IDS.chapters

function Probe({ id }: { id: string }) {
  useStartClosed(id)
  return null
}

let store: WindowStore
let root: Root
let container: HTMLDivElement

/** What `<Window>`'s own mount effect does: register with the shell. */
function register(): void {
  act(() => {
    store.getState().register({ id: ID, title: 'Kapitel' })
  })
}

/** ...and what its unmount does, which is what a recording without chapters causes. */
function unregister(): void {
  act(() => {
    store.getState().unregister(ID)
  })
}

function entry() {
  return store.getState().windows.find(w => w.id === ID)
}

beforeEach(() => {
  store = createWindowStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ShellProvider store={store}>
        <Probe id={ID} />
      </ShellProvider>,
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useStartClosed', () => {
  it('closes the window as soon as it registers', () => {
    expect(entry()).toBeUndefined()
    register()
    expect(entry()?.closed).toBe(true)
  })

  it('does not undo the user\'s own restore', () => {
    // The dock tile is the way back, and it writes exactly this. If the hook
    // re-fired on the resulting state change, the tile would look broken.
    register()
    act(() => store.getState().restore(ID))
    expect(entry()?.closed).toBe(false)
    // ...and it stays open across an unrelated store write, too.
    act(() => store.getState().setTitle(ID, 'Kapitel (2)'))
    expect(entry()?.closed).toBe(false)
  })

  it('does not re-close a window the user minimized and left minimized', () => {
    register()
    act(() => store.getState().restore(ID))
    act(() => store.getState().minimize(ID))
    expect(entry()?.minimized).toBe(true)
    expect(entry()?.closed).toBe(false)
  })

  it('REGRESSION: re-closes after the window unregisters and comes back', () => {
    // The exact path the dock's previous/next buttons walk: a recording WITH
    // chapters, a sibling WITHOUT (ChaptersWindow renders null, so `<Window>`
    // unregisters), then back to one with. Under the original once-EVER guard
    // the third step registered the window OPEN and it popped onto the shell
    // mid-lecture, unrequested - the whole point of the round being that only
    // the video is on screen at the start.
    register()
    expect(entry()?.closed).toBe(true)

    unregister()
    expect(entry()).toBeUndefined()

    register()
    expect(entry()?.closed).toBe(true)
  })

  it('survives several such round trips', () => {
    for (let i = 0; i < 3; i++) {
      register()
      expect(entry()?.closed).toBe(true)
      // The user opens it on this recording...
      act(() => store.getState().restore(ID))
      expect(entry()?.closed).toBe(false)
      // ...and steps to one that has no chapters at all.
      unregister()
    }
    register()
    expect(entry()?.closed).toBe(true)
  })

  it('leaves other windows alone', () => {
    act(() => {
      store.getState().register({ id: 'video-presenter', title: 'presenter' })
    })
    register()
    expect(entry()?.closed).toBe(true)
    expect(store.getState().windows.find(w => w.id === 'video-presenter')?.closed).toBe(false)
  })
})
