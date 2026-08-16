#!/usr/bin/env node
/**
 * End-to-end smoke test of the whole user journey, in a mobile viewport.
 *
 * There is no unit-test suite; this is the safety net. It drives the real app
 * against the real database, so run it before calling any change done.
 *
 * Requires a dev server on $BASE and FITTOWN_DEV_LOGIN=1 (see AGENTS.md).
 *
 *   node scripts/e2e.mjs [base-url]
 *
 * Exits non-zero on the first failed step or any browser console error.
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3000'

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})
const page = await context.newPage()

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160))
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`))

let failed = null
async function step(name, fn) {
  if (failed) return
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed = `${name}: ${err.message.split('\n')[0]}`
    console.error(`  ✗ ${name}\n    ${err.message.split('\n')[0]}`)
  }
}

await step('sign in (dev login)', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Sign in as Dev User/i }).click()
  await page.waitForURL(`${BASE}/`, { timeout: 15000 })
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(900)
})

await step('search and log a food', async () => {
  await page.goto(`${BASE}/add?meal=breakfast`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Search foods').fill('chicken breast')
  await page.waitForTimeout(1200)
  // Scoped to result links — `ul li a` also matches the hidden desktop nav.
  await page.locator('a[href^="/food/"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /Add to Breakfast/i }).click()
  await page.waitForURL(/\/\?d=/, { timeout: 15000 })
  await page.waitForTimeout(900)
})

await step('quick-add water', async () => {
  await page.getByRole('button', { name: /\+\s*(500 ml|16 oz)/ }).click()
  await page.waitForTimeout(900)
})

await step('log a workout', async () => {
  await page.goto(`${BASE}/fitness`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Search activities').fill('Running (10')
  await page.waitForTimeout(900)
  await page.locator('section button:has-text("Running")').first().click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /^Add workout$/ }).click()
  await page.waitForTimeout(1300)
})

await step('create a custom food', async () => {
  await page.goto(`${BASE}/food/new?meal=snack`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Porridge oats').fill('E2E Test Shake')
  await page.locator('label:has-text("Serving size") input').fill('300')
  await page.locator('label:has-text("Calories (kcal)") input').fill('180')
  await page.getByRole('button', { name: /Save and choose portion/i }).click()
  await page.waitForURL(/\/food\/\d+/, { timeout: 15000 })
  await page.waitForTimeout(800)
})

await step('custom food is immediately searchable (FTS sync)', async () => {
  await page.goto(`${BASE}/add?meal=snack`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Search foods').fill('E2E Test Shake')
  await page.waitForTimeout(1200)
  if ((await page.locator('a[href^="/food/"]').count()) === 0) {
    throw new Error('custom food missing from search — foods_fts not updated on insert')
  }
})

await step('edit an entry portion', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.locator('section a[href^="/food/"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)
  await page.locator('input[type=number]').first().fill('2')
  await page.getByRole('button', { name: /Save changes/i }).click()
  await page.waitForTimeout(1300)
})

await step('delete an entry', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const before = await page.locator('button[aria-label^="Remove"]').count()
  if (before === 0) throw new Error('nothing to delete — earlier steps did not log anything')
  await page.locator('button[aria-label^="Remove"]').first().click()
  await page.waitForTimeout(1200)
  const after = await page.locator('button[aria-label^="Remove"]').count()
  if (after >= before) throw new Error(`entry not removed (${before} -> ${after})`)
})

await step('goal change reaches the diary', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.locator('label:has-text("Daily calories") input').fill('2400')
  await page.getByRole('button', { name: /Save goals/i }).click()
  await page.waitForTimeout(1200)
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  if ((await page.locator('text=2400 goal').count()) === 0) {
    throw new Error('new calorie goal not reflected on the diary')
  }
})

await step('date navigation', async () => {
  await page.locator('button[aria-label="Previous day"]').click()
  await page.waitForTimeout(1200)
  const text = await page.locator('main').innerText()
  if (!text.includes('Yesterday')) throw new Error('date did not move back a day')
})

await step('trends renders', async () => {
  await page.goto(`${BASE}/trends`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  if ((await page.locator('text=Avg intake').count()) === 0) {
    throw new Error('trends page did not render its stats')
  }
})

await browser.close()

const unique = [...new Set(consoleErrors)]
if (unique.length) {
  console.error(`\nBrowser console errors:\n${unique.map((e) => `  ${e}`).join('\n')}`)
}

if (failed || unique.length) {
  console.error(`\nFAILED${failed ? `: ${failed}` : ' (console errors)'}`)
  process.exit(1)
}
console.log('\nAll steps passed, no console errors.')
