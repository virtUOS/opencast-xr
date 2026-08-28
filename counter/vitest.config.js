import { defineConfig } from 'vitest/config'

// Plain Node environment (not the root player app's jsdom) — this package is
// a server, it never touches a DOM.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.js'],
  },
})
