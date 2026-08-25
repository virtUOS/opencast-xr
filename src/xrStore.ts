import { createXRStore, type XRStore } from '@react-three/xr'
import { xrPointerOptions } from 'sphere-shell'

// Emulation (IWER) is enabled automatically on localhost by @react-three/xr.
// The automatic emulation didn't surface an overlay or an "immersive-vr"
// session in headless verification, so emulation is forced on explicitly.
//
// `xrPointerOptions` is NOT optional decoration. It carries the three pointer
// settings only the application can supply, because only the application
// creates the store:
//
//   - renderOrder. @react-three/xr draws the controller ray at renderOrder 2
//     and the cursor dot at 1, while sphere-shell's windows occupy
//     renderOrder 0…openCount-1 and the dock sits at 1_000_000. With more than
//     two windows open the pointer is drawn BEFORE the frontmost windows and is
//     therefore painted over by them — and because the ray's material inherits
//     MeshBasicMaterial's `depthWrite: true`, it also depth-occludes those
//     windows, punching a moving hole through their content.
//   - rayModel.maxLength. The ray is drawn `min(maxLength ?? 1, hitDistance)`
//     long, so with the upstream default it stops at 1 m — halfway to a shell
//     whose radius is 2 m — and looks like it never reaches the windows.
//   - clickThresholdMs. @pmndrs/pointer-events discards any press longer than
//     300 ms: `getIsClicked` returns false on
//     `buttonUpTime - objectButtonPressTime > clickThresholdMs`, and a rejected
//     click still emits pointerdown and pointerup. A deliberate VR press (aim,
//     settle, squeeze, release) routinely exceeds that, so buttons highlight
//     and then do nothing — which is exactly what the user reported from the
//     headset. Raised to XR_CLICK_THRESHOLD_MS (1500).
//
// The radius here must match <WindowShell radius> below (see App.tsx).
// See sphere-shell's core/renderOrder.ts and the README's Conventions section.
//
// (Copied from apps/demo/src/xrStore.ts — same rationale applies verbatim.)
export const SHELL_RADIUS = 2

// Explicit return-type annotation, unlike the demo's identical declaration:
// without it, tsc raises TS2742 ("The inferred type of 'xrStore' cannot be
// named without a reference to '.pnpm/@pmndrs+xr@…'") because pnpm's
// per-dependency nested install of @pmndrs/xr isn't a path tsc considers
// portable to name in a .d.ts. `XRStore` is @react-three/xr's own public
// alias for createXRStore's return type, so naming it here sidesteps the
// inference entirely (see task-10-report.md for the demo's pre-existing,
// un-annotated instance of this same error).
export const xrStore: XRStore = createXRStore({
  emulate: true,
  ...xrPointerOptions({ radius: SHELL_RADIUS }),
})
