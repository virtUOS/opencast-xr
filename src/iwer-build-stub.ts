// Build-only stand-in for the IWER emulator packages ('iwer', '@iwer/devui',
// '@iwer/sem'). vite.config.ts aliases those three specifiers to this file,
// but ONLY when running `vite build` -- `pnpm dev` resolves them normally.
//
// WHY THIS FILE EXISTS
// ---------------------
// @react-three/xr's WebXR emulator is implemented in @pmndrs/xr's
// dist/emulate.js, which statically imports:
//
//   import { DevUI } from '@iwer/devui';
//   import { SyntheticEnvironmentModule } from '@iwer/sem';
//   import { XRDevice, metaQuest3, metaQuest2, metaQuestPro, oculusQuest1 } from 'iwer';
//
// @iwer/sem in turn loads its "synthetic environment" scene captures --
// office_large.json, music_room.json, living_room.json, etc. -- via
// `import('./captures/<name>.json')` (node_modules/.pnpm/@iwer+sem@.../
// lib/captures/registry.js). Those captures are multi-megabyte JSON blobs.
//
// dist/emulate.js is itself only reached via a dynamic
// `import('./emulate.js')` inside @pmndrs/xr's store.js, guarded at
// *runtime* by whether `emulate` is truthy. src/xrStore.ts now sets
// `emulate: import.meta.env.DEV`, so that guard is false in production and
// the import is never executed by users. But that guard is a runtime value,
// invisible to Rollup: Vite's production build statically resolves and
// bundles every module reachable through a dynamic import syntactically,
// regardless of whether the surrounding runtime condition would ever fire.
// So without this alias, `vite build` still transforms and bundles
// emulate.js, iwer, @iwer/devui, and all five of @iwer/sem's JSON captures
// into dist/assets -- multiple megabytes of dead weight, and the exact
// thing that OOMs esbuild's transform step on a memory-constrained host:
// "FATAL ERROR: Reached heap limit ... transforming (3674)
// .../@iwer+sem@.../lib/captures/office_large.json".
//
// Aliasing 'iwer' / '@iwer/devui' / '@iwer/sem' to this file during `vite
// build` breaks that chain at its root: emulate.js still gets bundled (it's
// tiny on its own), but its imports resolve here instead of to the real,
// heavy packages, so none of iwer/@iwer's code or JSON ever enters the
// module graph, and no JSON transform ever happens.
//
// SAFETY: the real exports below are never called. @pmndrs/xr's `emulate()`
// function (the only consumer of these names) is unreachable in production
// because `emulate` is `false` at runtime -- see src/xrStore.ts. These
// stand-ins exist purely to satisfy emulate.js's named-import shape so the
// module still parses; nothing here needs to behave like the real thing.

export class XRDevice {}
export const metaQuest3 = undefined
export const metaQuest2 = undefined
export const metaQuestPro = undefined
export const oculusQuest1 = undefined
export class DevUI {}
export class SyntheticEnvironmentModule {}
