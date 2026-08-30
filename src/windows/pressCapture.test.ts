import { describe, expect, it } from 'vitest'
import { type PressState, initialPressState, reducePress } from './pressCapture'

describe('reducePress', () => {
  describe('pointerdown', () => {
    it('captures and starts tracking an enabled press', () => {
      const { state, effects } = reducePress(initialPressState, {
        type: 'pointerdown',
        pointerId: 1,
        disabled: false,
      })
      expect(state).toEqual({ pressing: true, pointerId: 1 })
      expect(effects).toEqual([{ type: 'capture', pointerId: 1 }])
    })

    it('does nothing for a disabled button - no capture, no tracking', () => {
      const { state, effects } = reducePress(initialPressState, {
        type: 'pointerdown',
        pointerId: 1,
        disabled: true,
      })
      expect(state).toEqual(initialPressState)
      expect(effects).toEqual([])
    })

    it('a second pointerdown re-arms tracking for the NEW pointer (most recent press wins)', () => {
      const afterFirst = reducePress(initialPressState, {
        type: 'pointerdown',
        pointerId: 1,
        disabled: false,
      }).state
      const { state, effects } = reducePress(afterFirst, { type: 'pointerdown', pointerId: 2, disabled: false })
      expect(state).toEqual({ pressing: true, pointerId: 2 })
      expect(effects).toEqual([{ type: 'capture', pointerId: 2 }])
    })
  })

  describe('pointerup', () => {
    const pressed: PressState = { pressing: true, pointerId: 1 }

    it('releases capture and fires for the tracked, enabled pointer', () => {
      const { state, effects } = reducePress(pressed, { type: 'pointerup', pointerId: 1, disabled: false })
      expect(state).toEqual(initialPressState)
      expect(effects).toEqual([{ type: 'release', pointerId: 1 }, { type: 'fire' }])
    })

    it('releases capture WITHOUT firing when disabled at release time', () => {
      const { state, effects } = reducePress(pressed, { type: 'pointerup', pointerId: 1, disabled: true })
      expect(state).toEqual(initialPressState)
      expect(effects).toEqual([{ type: 'release', pointerId: 1 }])
    })

    it('is a no-op for a FOREIGN pointer - the tracked one stays pressed', () => {
      const { state, effects } = reducePress(pressed, { type: 'pointerup', pointerId: 2, disabled: false })
      expect(state).toEqual(pressed)
      expect(effects).toEqual([])
    })

    it('is a no-op when nothing is pressed at all', () => {
      const { state, effects } = reducePress(initialPressState, {
        type: 'pointerup',
        pointerId: 1,
        disabled: false,
      })
      expect(state).toEqual(initialPressState)
      expect(effects).toEqual([])
    })

    it('release-anywhere-while-captured: a resolvable pointerup for the tracked pointer always fires, regardless of how the reducer got here (no distance/position input exists to cancel on)', () => {
      // There is no "fraction"/position field on a press event at all - see
      // this file's own doc comment on why no cheap cancel exists. This test
      // exists to document that absence: the ONLY things that can suppress
      // a fire are a foreign pointerId (tested above) or `disabled` (tested
      // above) - nothing else is even inspectable.
      const { effects } = reducePress(pressed, { type: 'pointerup', pointerId: 1, disabled: false })
      expect(effects.some((e) => e.type === 'fire')).toBe(true)
    })
  })

  describe('pointercancel', () => {
    const pressed: PressState = { pressing: true, pointerId: 1 }

    it('releases capture without firing, for the tracked pointer', () => {
      const { state, effects } = reducePress(pressed, { type: 'pointercancel', pointerId: 1 })
      expect(state).toEqual(initialPressState)
      expect(effects).toEqual([{ type: 'release', pointerId: 1 }])
    })

    it('is a no-op for a foreign pointer', () => {
      const { state, effects } = reducePress(pressed, { type: 'pointercancel', pointerId: 2 })
      expect(state).toEqual(pressed)
      expect(effects).toEqual([])
    })

    it('is a no-op when nothing is pressed at all', () => {
      const { state, effects } = reducePress(initialPressState, { type: 'pointercancel', pointerId: 1 })
      expect(state).toEqual(initialPressState)
      expect(effects).toEqual([])
    })
  })

  it('a full down-drift-up gesture (jitter case) still fires: down on the button, up still addressed to the SAME tracked pointer even though nothing here re-checks position', () => {
    const afterDown = reducePress(initialPressState, { type: 'pointerdown', pointerId: 7, disabled: false })
    expect(afterDown.effects).toEqual([{ type: 'capture', pointerId: 7 }])
    const afterUp = reducePress(afterDown.state, { type: 'pointerup', pointerId: 7, disabled: false })
    expect(afterUp.effects).toEqual([{ type: 'release', pointerId: 7 }, { type: 'fire' }])
    expect(afterUp.state).toEqual(initialPressState)
  })
})
