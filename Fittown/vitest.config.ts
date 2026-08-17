import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Unit tests run as plain Vitest, not through Nuxt.
 *
 * Everything worth unit-testing here is pure: the nutrient catalogue, the
 * portion and body-metric maths, the activity library, and the SQLite schema
 * migration (which only needs `node:sqlite` and a temp file). Booting Nuxt to
 * test them would add seconds per run and buy nothing — the parts that do need
 * a running app are covered by `scripts/e2e.mjs` instead.
 *
 * The `#shared` alias mirrors the one Nuxt sets up, so the modules under test
 * import exactly the same way in both environments.
 */
export default defineConfig({
  resolve: {
    alias: {
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      // Nuxt 4 points `~` at srcDir, which is `app/`. Mirrored here so the
      // pure display helpers under `app/utils/` can be tested directly.
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
