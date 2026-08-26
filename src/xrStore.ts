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
// `emulate` was `true` unconditionally, which forced @react-three/xr's IWER
// emulator into the PRODUCTION bundle too. IWER pulls in `iwer`,
// `@iwer/devui`, and `@iwer/sem` -- the latter ships multi-megabyte JSON
// "scene capture" files (captures/office_large.json etc.) that Vite/esbuild
// must transform during `vite build`. On memory-constrained hosts (a Rocky
// Linux 10 VM with little RAM, in production) this OOMs the build:
// "FATAL ERROR: Reached heap limit ... transforming (3674)
// .../@iwer+sem@.../lib/captures/office_large.json". The emulator is a
// desktop-dev aid only (it stands in for a headset when none is attached),
// so it has no business shipping to users. `import.meta.env.DEV` is Vite's
// static build-mode flag: true under `pnpm dev`, false in `vite build`,
// so this preserves the exact prior dev behavior (emulator forced on,
// matching @react-three/xr's `EmulatorOptions | boolean` type for `emulate`)
// while disabling it in production. This alone does not stop the emulator's
// code from being bundled, though -- see the build-only alias in
// vite.config.ts for the second half of the fix.
export const xrStore: XRStore = createXRStore({
  emulate: import.meta.env.DEV,
  ...xrPointerOptions({ radius: SHELL_RADIUS }),
})
