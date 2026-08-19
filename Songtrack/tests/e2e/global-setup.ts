import { execSync } from 'node:child_process'

const BASE_URL = 'http://localhost:8194'
export const TEST_USER_EMAIL = 'playwright-test@example.com'

/**
 * Runs once before the whole e2e suite: creates the test user (via the
 * ALLOW_TEST_LOGIN-gated bypass, since real Google OAuth can't be driven
 * headlessly) and imports one fixture song so specs have something to click
 * on without each re-implementing recording/upload from scratch.
 */
async function waitForServer(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`)
}

export default async function globalSetup() {
  // globalSetup isn't guaranteed to run after webServer is ready (playwright#19571) — wait explicitly.
  await waitForServer(`${BASE_URL}/api/_test-login`)
  await fetch(`${BASE_URL}/api/_test-login`)

  execSync('pnpm exec tsx --env-file=.env scripts/import.ts tests/e2e/fixtures --user playwright-test@example.com', {
    env: { ...process.env, DATA_DIR: '.data-e2e' },
    stdio: 'inherit',
  })
}
