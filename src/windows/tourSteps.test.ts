import { describe, expect, it } from 'vitest'
import { TOUR_CONTROL_IDS, TOUR_STEPS } from './tourSteps'

/**
 * Confirmed-missing glyphs in this project's installed uikit default font -
 * see `docs/UIKIT-NOTES.md` entry 3. Every in-scene string in this app avoids
 * them; the tour's copy is no exception.
 */
const FORBIDDEN_CHARS = ['‹', '·', '…', '•', '→', '✕', '–']

describe('TOUR_STEPS', () => {
  it('has one entry per agreed step, in order', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      'controller',
      'transport',
      'navigation',
      'captions',
      'audio',
      'panels',
      'menu',
    ])
  })

  it('gives every step at least one line of copy', () => {
    for (const step of TOUR_STEPS) {
      expect(step.lines.length).toBeGreaterThan(0)
      for (const line of step.lines) {
        expect(line.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('never uses a glyph missing from the installed uikit font', () => {
    for (const step of TOUR_STEPS) {
      for (const line of step.lines) {
        for (const bad of FORBIDDEN_CHARS) {
          expect(line.includes(bad)).toBe(false)
        }
      }
    }
  })

  it('only highlights ids that are real dock control ids', () => {
    const validIds = new Set<string>(Object.values(TOUR_CONTROL_IDS))
    for (const step of TOUR_STEPS) {
      for (const id of step.highlightIds) {
        expect(validIds.has(id)).toBe(true)
      }
    }
  })

  it('the first step is the controller/window reference list, with nothing to highlight', () => {
    const first = TOUR_STEPS[0]!
    expect(first.id).toBe('controller')
    expect(first.bullet).toBe(true)
    expect(first.highlightIds).toEqual([])
  })

  it("the last step (shell-owned menu/exit) highlights nothing - those aren't this app's IconButtons", () => {
    const last = TOUR_STEPS[TOUR_STEPS.length - 1]!
    expect(last.id).toBe('menu')
    expect(last.highlightIds).toEqual([])
  })

  it('every other step highlights at least one control', () => {
    for (const step of TOUR_STEPS) {
      if (step.id === 'controller' || step.id === 'menu') continue
      expect(step.highlightIds.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate control ids', () => {
    const values = Object.values(TOUR_CONTROL_IDS)
    expect(new Set(values).size).toBe(values.length)
  })
})
