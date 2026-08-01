import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// These suites cover the pure logic — matching, name validation, the JSON store — so they
// run in plain node without booting Nuxt. `#shared` is aliased by hand to match the alias
// Nuxt provides at runtime.
export default defineConfig({
  // Keep Vite's transform cache off the network mount — on CIFS it is slow enough to look
  // like a hang. Override with VITEST_CACHE_DIR if /tmp isn't writable.
  cacheDir: process.env.VITEST_CACHE_DIR || '/tmp/nshoppinglist-vitest',
  resolve: {
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The project lives on a network mount, where a worker per test file is enough to get
    // the run OOM-killed. These suites are fast and pure, so one process is plenty.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
