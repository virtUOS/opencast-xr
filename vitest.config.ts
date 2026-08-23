import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose, same reasoning as the demo app's:
// vitest prefers `vitest.config.*` over `vite.config.*`, and the dev config's
// `vite-plugin-mkcert` has no business running in a test process. jsdom (not
// the demo's plain `node`) because this app's data layer parses Opencast API
// responses and VTT captions destined for DOM-facing components.
export default defineConfig({
  test: { environment: 'jsdom', globals: false, include: ['src/**/*.test.ts?(x)'] },
})
