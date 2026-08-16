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
  await page.getByRole('button', { name: /Save settings/i }).click()
  await page.waitForTimeout(1200)
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  if ((await page.locator('text=2400 goal').count()) === 0) {
    throw new Error('new calorie goal not reflected on the diary')
  }
})

await step('portion units convert to grams', async () => {
  await page.goto(`${BASE}/add?meal=lunch`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Search foods').fill('chicken breast')
  await page.waitForTimeout(1200)
  await page.locator('a[href^="/food/"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)

  // Pick ounces and check the app says what that works out to. 4 oz is
  // 113.4 g; anything else means the conversion table or the maths moved.
  await page.locator('label:has-text("Portion") select').selectOption('u:oz')
  await page.waitForTimeout(400)
  await page.locator('label:has-text("Amount") input').fill('4')
  await page.waitForTimeout(400)

  const text = await page.locator('main').innerText()
  if (!/4 × oz = 113 g/.test(text)) {
    throw new Error(`no oz→g conversion shown. Page said: ${text.slice(0, 200)}`)
  }
  if (!/Logging 113 g/.test(text)) throw new Error('resolved grams not shown')
})

await step('body metrics and calculated calorie target', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  await page.locator('label:has-text("Age") input').fill('41')
  await page.locator('label:has-text("Gender") select').selectOption('female')
  await page.locator('input[aria-label="Height in centimetres"]').fill('168')
  await page.locator('label:has-text("Activity level") select').selectOption('moderate')
  await page.waitForTimeout(300)

  // Choosing anything above sedentary must warn about double-logging exercise.
  const settingsText = await page.locator('main').innerText()
  if (!/already includes your usual training/i.test(settingsText)) {
    throw new Error('no double-counting note shown for a non-sedentary activity level')
  }

  await page.locator('input[aria-label="Weight"]').fill('72.5')
  await page.getByRole('button', { name: 'Log', exact: true }).click()
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /Save settings/i }).click()
  await page.waitForTimeout(1200)

  await page.getByRole('button', { name: /Calculate calorie target/i }).click()
  await page.waitForTimeout(600)

  const dialog = page.locator('dialog.modal')
  if (!(await dialog.isVisible())) throw new Error('calculator did not open')
  const maintenance = await dialog.innerText()
  if (!/Maintain weight/.test(maintenance)) throw new Error('no maintenance figure shown')

  await dialog.getByRole('tab', { name: 'lose' }).click()
  await page.waitForTimeout(300)
  await dialog.getByRole('button', { name: /^0\.5 kg$/ }).click()
  await page.waitForTimeout(300)
  await dialog.getByRole('button', { name: /Use this target/i }).click()
  await page.waitForTimeout(1500)

  const after = await page.locator('main').innerText()
  if (!/Your plan/.test(after)) throw new Error('plan not stored after applying a target')
  if (!/Losing 0\.5 kg a week/.test(after)) {
    throw new Error(`plan summary wrong: ${after.slice(0, 200)}`)
  }

  // A 0.5 kg/week deficit is 550 kcal off maintenance, so the goal must have
  // moved off the 2400 the previous step set.
  const goal = await page.locator('label:has-text("Daily calories") input').inputValue()
  if (Number(goal) === 2400 || Number(goal) < 800) {
    throw new Error(`calorie goal not recalculated (got ${goal})`)
  }
})

await step('weight logs to the diary and can be back-dated', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)

  const todayText = await page.locator('section:has(h2:text("Weight"))').innerText()
  if (!/72\.5/.test(todayText)) {
    throw new Error(`weight logged in settings not shown on the diary: ${todayText}`)
  }

  // Setting yesterday's weight is the back-dating path. The button reads "Log"
  // or "Edit" depending on whether a previous run already left a reading here,
  // so match either — this script runs repeatedly against the same database.
  await page.locator('button[aria-label="Previous day"]').click()
  await page.waitForTimeout(1200)
  await page
    .locator('button[aria-label="Log weight"], button[aria-label="Edit weight"]')
    .click()
  await page.waitForTimeout(300)
  await page.locator('input[aria-label="Weight"]').fill('73.1')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await page.waitForTimeout(1300)

  const yesterday = await page.locator('section:has(h2:text("Weight"))').innerText()
  if (!/73\.1/.test(yesterday)) {
    throw new Error(`back-dated weight did not save: ${yesterday}`)
  }
})

await step('trends year view charts weight', async () => {
  await page.goto(`${BASE}/trends`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.getByRole('tab', { name: '1y' }).click()
  await page.waitForTimeout(1500)

  if ((await page.locator('svg polyline').count()) === 0) {
    throw new Error('year view drew no weight line')
  }
  const text = await page.locator('main').innerText()
  if (!/weekly average/.test(text)) {
    throw new Error('year view did not switch calories to weekly averages')
  }
})

await step('date navigation', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
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
