import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mkcert from 'vite-plugin-mkcert'

// See src/xrStore.ts for the full story: @react-three/xr's WebXR emulator
// (IWER) is a desktop-dev-only aid, but @pmndrs/xr's store.js reaches it
// via `import('./emulate.js')`, which Rollup bundles statically regardless
// of the runtime `emulate` flag -- and emulate.js in turn statically
// imports 'iwer', '@iwer/devui', and '@iwer/sem', the last of which ships
// multi-megabyte JSON scene captures. Left alone, `vite build` transforms
// and bundles all of that into dist/assets, which OOMs on memory-
// constrained hosts. Aliasing those three specifiers to a tiny local stub
// -- ONLY for `vite build`, never for `vite dev` -- keeps the emulator's
// code and JSON out of the production module graph entirely, so nothing
// heavy is ever there for Rollup to transform or bundle.
const iwerBuildStub = fileURLToPath(new URL('./src/iwer-build-stub.ts', import.meta.url))

export default defineConfig(({ command }) => ({
  plugins: [react(), mkcert()],
  server: { https: true, host: true },
  resolve: {
    alias:
      command === 'build'
        ? {
            iwer: iwerBuildStub,
            '@iwer/devui': iwerBuildStub,
            '@iwer/sem': iwerBuildStub,
          }
        : {},
  },
}))
