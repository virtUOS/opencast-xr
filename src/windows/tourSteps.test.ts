import { describe, expect, it } from 'vitest'
import {
  TOUR_CONTROL_IDS,
  TOUR_STEPS,
  type TourBadgeId,
  badgeHand,
  tourLineText,
} from './tourSteps'

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

  it('gives every step at least one line of copy, with non-empty text either way (plain string or structured row)', () => {
    for (const step of TOUR_STEPS) {
      expect(step.lines.length).toBeGreaterThan(0)
      for (const line of step.lines) {
        expect(tourLineText(line).trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('never uses a glyph missing from the installed uikit font, in any line of any step', () => {
    for (const step of TOUR_STEPS) {
      for (const line of step.lines) {
        const text = tourLineText(line)
        for (const bad of FORBIDDEN_CHARS) {
          expect(text.includes(bad)).toBe(false)
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

  describe('the controller step - structured binding rows', () => {
    const controller = TOUR_STEPS[0]!

    it('every structured row carries at least a badge or an icon (never neither), and no line is a bare empty object', () => {
      for (const line of controller.lines) {
        if (typeof line === 'string') continue
        const hasBadges = (line.badges?.length ?? 0) > 0
        const hasIcon = line.icon != null
        expect(hasBadges || hasIcon).toBe(true)
      }
    })

    it('every badge id is one of the four real Quest face buttons', () => {
      const valid = new Set<TourBadgeId>(['A', 'B', 'X', 'Y'])
      for (const line of controller.lines) {
        if (typeof line === 'string') continue
        for (const badge of line.badges ?? []) {
          expect(valid.has(badge)).toBe(true)
        }
      }
    })

    it('every icon id is a known controller glyph', () => {
      const valid = new Set(['trigger', 'stick'])
      for (const line of controller.lines) {
        if (typeof line === 'string') continue
        if (line.icon != null) expect(valid.has(line.icon)).toBe(true)
      }
    })

    it('the trigger row leads with the trigger icon and no badges', () => {
      const row = controller.lines.find((l) => typeof l !== 'string' && l.icon === 'trigger')
      expect(row).toBeDefined()
      expect(typeof row === 'object' && row?.badges).toBeUndefined()
    })

    it('both stick rows and the rotate row lead with the stick icon', () => {
      const stickRows = controller.lines.filter((l) => typeof l !== 'string' && l.icon === 'stick')
      expect(stickRows.length).toBe(3) // left/right scrub, left up/down chapter jump, right rotate
    })

    it('the play/pause row carries exactly the A and X badges, in that order', () => {
      const row = controller.lines.find(
        (l) => typeof l !== 'string' && l.badges != null && l.badges.length > 0 && l.badges[0] === 'A',
      )
      expect(row).toBeDefined()
      expect(typeof row === 'object' && row?.badges).toEqual(['A', 'X'])
    })

    it('the recenter row carries exactly the B badge', () => {
      const row = controller.lines.find((l) => typeof l !== 'string' && l.badges?.includes('B'))
      expect(row).toBeDefined()
      expect(typeof row === 'object' && row?.badges).toEqual(['B'])
    })

    it('a clarifying plain-string line about controller sides appears before the first badge row', () => {
      const clarifyIndex = controller.lines.findIndex(
        (l) => typeof l === 'string' && l.includes('rechten Controller') && l.includes('linken'),
      )
      const firstBadgeIndex = controller.lines.findIndex((l) => typeof l !== 'string' && (l.badges?.length ?? 0) > 0)
      expect(clarifyIndex).toBeGreaterThanOrEqual(0)
      expect(firstBadgeIndex).toBeGreaterThan(clarifyIndex)
    })

    it('the window-drag line stays a plain string - it is not a controller-button binding', () => {
      const last = controller.lines[controller.lines.length - 1]!
      expect(typeof last).toBe('string')
      expect(tourLineText(last)).toContain('Fenster')
    })
  })
})

describe('badgeHand', () => {
  it('puts A and B on the right controller', () => {
    expect(badgeHand('A')).toBe('rechts')
    expect(badgeHand('B')).toBe('rechts')
  })

  it('puts X and Y on the left controller', () => {
    expect(badgeHand('X')).toBe('links')
    expect(badgeHand('Y')).toBe('links')
  })
})

describe('tourLineText', () => {
  it('returns a plain string unchanged', () => {
    expect(tourLineText('hello')).toBe('hello')
  })

  it('returns a structured row\'s own text', () => {
    expect(tourLineText({ icon: 'stick', text: 'spulen' })).toBe('spulen')
    expect(tourLineText({ badges: ['A'], text: 'Wiedergabe' })).toBe('Wiedergabe')
  })
})
