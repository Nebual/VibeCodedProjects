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

await step('log a workout by drilling into a category', async () => {
  await page.goto(`${BASE}/fitness`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  // The category grid replaced the flat list; household chores are logged the
  // same way as gym sessions.
  await page.getByRole('button', { name: /Household/ }).click()
  await page.waitForTimeout(1000)
  await page.locator('ul li button:has-text("Vacuuming")').first().click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: /^Add workout$/ }).click()
  await page.waitForTimeout(1300)

  if (!/Vacuuming/.test(await page.locator('main').innerText())) {
    throw new Error('workout logged from the category grid did not appear')
  }
})

await step('effort level changes the calorie estimate', async () => {
  await page.goto(`${BASE}/fitness`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.getByPlaceholder('Search activities').fill('Running')
  await page.waitForTimeout(1100)
  await page.locator('ul li button:has-text("Running")').first().click()
  await page.waitForTimeout(600)

  const kcal = (text) => Number((text.match(/(\d+)\s*kcal/) || [])[1])
  const light = kcal(await page.getByRole('tab', { name: /Light/ }).innerText())
  const hard = kcal(await page.getByRole('tab', { name: /Hard/ }).innerText())
  if (!(hard > light)) {
    throw new Error(`hard effort should burn more than light (${light} vs ${hard})`)
  }

  await page.getByRole('tab', { name: /Hard/ }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^Add workout$/ }).click()
  await page.waitForTimeout(1300)

  if (!/hard/.test(await page.locator('main').innerText())) {
    throw new Error('effort not recorded against the logged workout')
  }
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

  // Not `label:has-text("Age")` — that also matches "Protein percentage".
  await page.locator('input[aria-label="Age"]').fill('41')
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

  const todayText = await page.locator('section:has(h2:text("Body"))').innerText()
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

  const yesterday = await page.locator('section:has(h2:text("Body"))').innerText()
  if (!/73\.1/.test(yesterday)) {
    throw new Error(`back-dated weight did not save: ${yesterday}`)
  }
})

await step('custom biometrics log alongside weight', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1100)
  const card = page.locator('section:has(h2:text("Body"))')

  // The type may already exist from an earlier run of this script.
  if ((await card.getByRole('button', { name: 'Set Bicep' }).count()) === 0) {
    await card.getByRole('button', { name: /Add a measurement/ }).click()
    await page.locator('input[aria-label="Measurement name"]').fill('Bicep')
    await page.locator('select[aria-label="Unit"]').selectOption('cm')
    await page.getByRole('button', { name: /Track it/ }).click()
    await page.waitForTimeout(1300)
  }

  await card.getByRole('button', { name: 'Set Bicep' }).click()
  await page.locator('input[aria-label="Bicep"]').fill('38.5')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1400)

  if (!/38\.5\s*cm/.test(await card.innerText())) {
    throw new Error(`bicep measurement not saved: ${await card.innerText()}`)
  }
})

await step('macro split edits grams', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  await page.getByRole('button', { name: /Reset to 25 \/ 45 \/ 30/ }).click()
  await page.waitForTimeout(400)

  const percent = await page.getByLabel('Protein percentage').inputValue()
  if (Number(percent) !== 25) throw new Error(`protein should be 25%, got ${percent}`)

  const goal = Number(await page.locator('label:has-text("Daily calories") input').inputValue())
  const grams = Number(await page.getByLabel('Protein grams').inputValue())
  const expected = Math.round((goal * 0.25) / 4)
  if (grams !== expected) {
    throw new Error(`protein grams should be ${expected} for a ${goal} kcal goal, got ${grams}`)
  }

  if (!/100% of your calorie goal/.test(await page.locator('main').innerText())) {
    throw new Error('split should total 100% after reset')
  }
})

await step('goal weight picks the direction', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  // Clear any stored plan first: the dialog deliberately resumes one when it
  // exists, so the default rate is only observable from a clean slate.
  const clear = page.getByRole('button', { name: /^Clear$/ })
  if (await clear.count()) {
    await clear.click()
    await page.waitForTimeout(1300)
  }

  await page.getByRole('button', { name: /Calculate calorie target/i }).click()
  await page.waitForTimeout(600)

  const dialog = page.locator('dialog.modal')
  await dialog.getByRole('tab', { name: 'Maintain' }).click()
  await page.waitForTimeout(300)

  // Current weight is 72.5 kg, so a 68 kg goal means losing — without touching
  // the direction tabs.
  await dialog.locator('label:has-text("Goal weight") input').fill('68')
  await page.waitForTimeout(500)

  const text = await dialog.innerText()
  if (!/Lose per week/.test(text)) {
    throw new Error(`goal below current weight should switch to Lose: ${text.slice(0, 200)}`)
  }
  // Default rate is half a pound a week, which is 0.23 kg. Read the field:
  // an input's value never appears in innerText.
  const rate = await dialog.getByLabel('Custom weekly rate').inputValue()
  if (Number(rate) !== 0.23) {
    throw new Error(`expected a 0.23 kg/week default rate, got ${rate}`)
  }

  await dialog.getByRole('button', { name: /Cancel/ }).click()
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
