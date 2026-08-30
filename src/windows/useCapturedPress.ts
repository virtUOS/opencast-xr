import { useCallback, useRef } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { type PressEffect, type PressState, initialPressState, reducePress } from './pressCapture'

/**
 * Wires `pressCapture.ts`'s pure reducer onto a uikit `Container`'s pointer
 * handlers - the thin glue layer, same split as `timelineDrag.ts`/
 * `DockTransport.tsx`'s `applyEffects`. See that module's doc comment for WHY
 * a discrete button needs pointer capture at all.
 *
 * Right-click is filtered out before the reducer ever sees it - matching the
 * `onClick` this replaces, which `@pmndrs/pointer-events` never synthesises
 * for `nativeEvent.button === 2` (`docs/UIKIT-NOTES.md` entry 6a's
 * `contextMenuButton`). Filtered at THIS layer, not in the reducer: it's a
 * native-event/DOM-button concern, not part of the press/release/capture
 * decision `pressCapture.ts`'s own tests cover.
 *
 * The right-click check in `onPointerDown` runs BEFORE `e.stopPropagation()`,
 * deliberately: a right-click on a button never called `stopPropagation`
 * under the old `onClick` either (the browser's own `click` synthesis simply
 * never fired for it, so nothing downstream of that ran), so an early return
 * ahead of the call preserves that exact pre-existing behaviour - a
 * right-click still propagates normally (e.g. to a background look-drag),
 * same as before this fix (code review round 1, Minor 2).
 *
 * `e.stopPropagation()` on both `pointerdown` and `pointerup` - unconditional,
 * matching every existing button's own `onClick` in this app (which always
 * stopped propagation before its `disabled` check), PLUS the `pointerdown`
 * half `onClick` never needed on its own (a bare `onClick`-only button had no
 * separate down handler) - see `DockTransport.tsx`'s track `pointerdown`,
 * which stops propagation just as eagerly for the same reason: a press
 * starting on a button must not also let a background look-drag start
 * underneath it.
 */
export function useCapturedPress(onPress: () => void, disabled = false) {
  const stateRef = useRef<PressState>(initialPressState)

  const applyEffects = useCallback(
    (effects: PressEffect[], e: ThreeEvent<PointerEvent>) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'capture':
            ;(e.target as Element).setPointerCapture?.(effect.pointerId)
            break
          case 'release':
            ;(e.target as Element).releasePointerCapture?.(effect.pointerId)
            break
          case 'fire':
            onPress()
            break
        }
      }
    },
    [onPress],
  )

  const onPointerDown = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (e.button === 2) return // right-click - see the doc comment above
      e.stopPropagation()
      const { state, effects } = reducePress(stateRef.current, {
        type: 'pointerdown',
        pointerId: e.pointerId,
        disabled,
      })
      stateRef.current = state
      applyEffects(effects, e)
    },
    [applyEffects, disabled],
  )

  const onPointerUp = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation()
      const { state, effects } = reducePress(stateRef.current, {
        type: 'pointerup',
        pointerId: e.pointerId,
        disabled,
      })
      stateRef.current = state
      applyEffects(effects, e)
    },
    [applyEffects, disabled],
  )

  const onPointerCancel = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const { state, effects } = reducePress(stateRef.current, { type: 'pointercancel', pointerId: e.pointerId })
      stateRef.current = state
      applyEffects(effects, e)
    },
    [applyEffects],
  )

  return { onPointerDown, onPointerUp, onPointerCancel }
}
