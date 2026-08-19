import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const PORT = 8194

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // all specs share one server + SQLite file
  retries: 0,
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm run dev',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      NITRO_PORT: String(PORT),
      ALLOW_TEST_LOGIN: 'true',
      // Isolated from the real dev database so e2e runs never touch real data.
      DATA_DIR: '.data-e2e',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${join(process.cwd(), 'tests/e2e/fixtures/test-tone.wav')}`,
          ],
        },
      },
    },
  ],
})
