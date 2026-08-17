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

/**
 * Errors a step provoked on purpose.
 *
 * The browser logs every non-2xx fetch as a console error, so a step that
 * asserts a refusal would otherwise fail the run for succeeding. A step adds
 * its pattern here before triggering it; everything else still fails the run.
 */
const expectedConsoleErrors = []

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

await step('recently used activities are offered for quick access', async () => {
  await page.goto(`${BASE}/fitness`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)

  // The previous step logged Vacuuming, so it must now be one tap away
  // without opening a category.
  const recent = page.locator('div:has(> span:text-is("Recent")) button')
  if ((await recent.count()) === 0) throw new Error('no Recent row rendered')
  if (!/Vacuuming/.test(await recent.first().innerText())) {
    throw new Error(
      `most recent activity should be first, got "${await recent.first().innerText()}"`,
    )
  }
  if ((await recent.count()) > 10) throw new Error('Recent should cap at 10')

  // Tapping one selects it, skipping the grid entirely.
  await recent.first().click()
  await page.waitForTimeout(500)
  if ((await page.getByRole('button', { name: /^Add workout$/ }).count()) === 0) {
    throw new Error('tapping a recent activity did not open the workout form')
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

await step('trends charts custom biometrics', async () => {
  // The biometrics step logged a bicep measurement for today; add one for
  // yesterday so there are two points and a line can actually be drawn.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1000)
  await page.locator('button[aria-label="Previous day"]').click()
  await page.waitForTimeout(1200)
  await page.locator('section:has(h2:text("Body"))').getByRole('button', { name: 'Set Bicep' }).click()
  await page.locator('input[aria-label="Bicep"]').fill('38.1')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1400)

  await page.goto(`${BASE}/trends`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  const bicep = page.locator('section:has(h2:text-is("Bicep"))')
  if ((await bicep.count()) === 0) {
    throw new Error('no Bicep chart on Trends')
  }
  if ((await bicep.locator('svg polyline').count()) === 0) {
    throw new Error('Bicep chart drew no line')
  }
  // Charted in the unit the measurement was defined with, not converted.
  if (!/cm/.test(await bicep.innerText())) {
    throw new Error(`Bicep chart should be labelled in cm: ${await bicep.innerText()}`)
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

// ---------------------------------------------------------------------------
// Recipes
//
// A recipe is a foods row whose nutrition is derived from its ingredients, so
// the thing worth asserting is arithmetic: one serving of a four-serving recipe
// has to be a quarter of what went in. The rest guards the promise that the app
// never quotes a weight for a dish nobody weighed.
// ---------------------------------------------------------------------------

const recipeName = `E2E Recipe ${Date.now()}`
let recipeUrl = null

await step('create a recipe', async () => {
  await page.goto(`${BASE}/recipes`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Grandma').fill(recipeName)
  await page.getByRole('button', { name: /^Create$/ }).click()
  await page.waitForURL(/\/recipes\/\d+/, { timeout: 15000 })
  await page.waitForTimeout(600)
  recipeUrl = page.url()
})

await step('add two ingredients through the food search', async () => {
  for (const [term, grams] of [['chicken breast', '200'], ['white rice', '300']]) {
    await page.getByRole('link', { name: /Add ingredient/i }).click()
    await page.waitForLoadState('networkidle')
    await page.getByPlaceholder('Search foods').fill(term)
    await page.waitForTimeout(1200)
    await page.locator('a[href^="/food/"]').first().click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(600)

    // Grams, so the expected totals below are arithmetic rather than guesswork.
    await page.locator('label:has-text("Portion") select').selectOption({ label: 'g' })
    await page.locator('label:has-text("Amount") input').fill(grams)
    await page.getByRole('button', { name: /Add to recipe/i }).click()
    await page.waitForURL(/\/recipes\/\d+/, { timeout: 15000 })
    await page.waitForTimeout(700)
  }

  const text = await page.locator('main').innerText()
  if (!/500 g in/.test(text)) throw new Error(`ingredient weight not totalled: ${text.slice(0, 300)}`)
})

await step('servings set the serving size', async () => {
  await page.locator('label:has-text("Servings") input').fill('4')
  await page.locator('label:has-text("Servings") input').blur()
  await page.waitForTimeout(1200)

  const headlineKcal = async () =>
    Number(
      (await page.locator('section:has(h2:text("Nutrition"))').innerText()).match(
        /(\d+)\s*kcal/,
      )[1],
    )

  await page.getByRole('tab', { name: /Whole recipe/ }).click()
  await page.waitForTimeout(300)
  const whole = await headlineKcal()

  await page.getByRole('tab', { name: /Per serving/ }).click()
  await page.waitForTimeout(300)
  const perServing = await headlineKcal()
  // The number the whole feature exists to produce.
  if (Math.abs(perServing - whole / 4) > 2) {
    throw new Error(`a serving should be a quarter of the recipe (${perServing} vs ${whole}/4)`)
  }
})

await step('an unweighed recipe offers servings, not grams', async () => {
  await page.goto(`${recipeUrl.replace('/recipes/', '/food/')}?meal=dinner`, {
    waitUntil: 'networkidle',
  })
  await page.waitForTimeout(700)

  const options = await page.locator('label:has-text("Portion") select option').allInnerTexts()
  if (options.some((o) => /\bg\b|\boz\b|\bkg\b/.test(o))) {
    throw new Error(`gram portions offered for a recipe with no stated yield: ${options}`)
  }
  if (!options.some((o) => /whole recipe/i.test(o)) || !options.some((o) => /serving/i.test(o))) {
    throw new Error(`expected serving and whole recipe, got: ${options}`)
  }
  // And the default is one serving, not the whole pot.
  const selected = await page.locator('label:has-text("Portion") select').inputValue()
  const first = await page.locator('label:has-text("Portion") select option').first().getAttribute('value')
  if (selected !== first) throw new Error('the picker did not default to the first option')
  if (!/serving/i.test(await page.locator('label:has-text("Portion") select option:checked').innerText())) {
    throw new Error('the picker should default to 1 serving')
  }
})

await step('logging a serving carries its share of the nutrition', async () => {
  await page.getByRole('button', { name: /Add to Dinner/i }).click()
  await page.waitForURL(/\/\?d=/, { timeout: 15000 })
  await page.waitForTimeout(1000)

  // Scoped to the recipe's own row: the meal holds other entries from earlier
  // steps, and those are weighed foods that quite rightly show grams.
  const row = page.locator('section:has(h2:text("Dinner")) li', { hasText: recipeName })
  if ((await row.count()) === 0) {
    throw new Error(
      `recipe missing from the diary: ${await page.locator('section:has(h2:text("Dinner"))').innerText()}`,
    )
  }
  const rowText = await row.first().innerText()
  if (!/1 × serving/.test(rowText)) {
    throw new Error(`expected the entry to read as one serving: ${rowText}`)
  }
  // No weight is quoted, because none was ever measured.
  if (/\d+\s*g\b/.test(rowText)) {
    throw new Error(`the diary quoted a weight for an unweighed recipe: ${rowText}`)
  }
})

await step('stating a final weight unlocks gram portions', async () => {
  await page.goto(recipeUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await page.locator('label:has-text("Final weight") input[type="number"]').fill('400')
  await page.locator('label:has-text("Final weight") input[type="number"]').blur()
  await page.waitForTimeout(1200)

  const text = await page.locator('main').innerText()
  if (!/One serving is 100 g/.test(text)) {
    throw new Error(`serving size should follow the yield: ${text.slice(0, 400)}`)
  }

  await page.goto(`${recipeUrl.replace('/recipes/', '/food/')}?meal=dinner`, {
    waitUntil: 'networkidle',
  })
  await page.waitForTimeout(700)
  const options = await page.locator('label:has-text("Portion") select option').allInnerTexts()
  if (!options.some((o) => /^g$/.test(o.trim()))) {
    throw new Error(`grams should be offered once the dish is weighed: ${options}`)
  }
})

await step('renaming a recipe re-indexes it for search', async () => {
  await page.goto(recipeUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const renamed = `${recipeName} Renamed`
  await page.locator('label:has-text("Name") input').fill(renamed)
  await page.locator('label:has-text("Name") input').blur()
  await page.waitForTimeout(1200)

  await page.goto(`${BASE}/add?meal=dinner`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Search foods').fill(renamed)
  await page.waitForTimeout(1400)
  if ((await page.locator('a[href^="/food/"]').count()) === 0) {
    throw new Error('renamed recipe missing from search — foods_fts not updated on rename')
  }
})

await step('a logged recipe refuses to be deleted', async () => {
  // The refusal is the point, and the browser logs the 409 as a console error.
  expectedConsoleErrors.push(/409/)

  await page.goto(recipeUrl, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.locator('button[aria-label="Delete recipe"]').click()
  await page.getByRole('button', { name: /Delete for good/i }).click()
  await page.waitForTimeout(1200)

  const text = await page.locator('main').innerText()
  if (!/Logged 1 time/.test(text)) {
    throw new Error(`expected a refusal naming the diary entries: ${text.slice(0, 400)}`)
  }
})

// ---------------------------------------------------------------------------
// Friends and sharing.
//
// Needs a second person, so this section runs a second browser context signed
// in as somebody else. The friend's address is unique per run: dev login
// creates a user for any address, and a fixed one would already be friends on
// the second run.
//
// What it guards: that a request reaches the other person as a prompt, that a
// friend's recipe is readable but not editable and copies into your own, that
// a sharing switch actually closes a door, and that a public recipe link opens
// with no session at all.
// ---------------------------------------------------------------------------

const friendEmail = `e2e-friend-${Date.now()}@fittown.local`
const friendContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})
const friendPage = await friendContext.newPage()
friendPage.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`friend: ${m.text().slice(0, 160)}`)
})
friendPage.on('pageerror', (e) => consoleErrors.push(`friend pageerror: ${e.message.slice(0, 160)}`))

await step('a friend request arrives as a prompt and is accepted', async () => {
  await friendPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await friendPage.evaluate(
    (email) => fetch('/auth/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'E2E Friend' }),
    }),
    friendEmail,
  )

  await friendPage.goto(`${BASE}/friends`, { waitUntil: 'networkidle' })
  await friendPage.getByPlaceholder('them@example.com').fill('dev@fittown.local')
  await friendPage.getByRole('button', { name: 'Ask' }).click()
  await friendPage.locator('main', { hasText: 'Waiting on' }).waitFor({ timeout: 10000 })

  // The point of the prompt: it finds you wherever you happen to be.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const modal = page.locator('.modal-open')
  await modal.waitFor({ timeout: 10000 })
  await modal.getByRole('button', { name: 'Accept' }).click()
  await page.waitForTimeout(1000)
  if (await page.locator('.modal-open').count()) throw new Error('prompt stayed open')
})

await step('a friend’s recipe is read-only and copies into your own', async () => {
  await friendPage.goto(`${BASE}/friends`, { waitUntil: 'networkidle' })
  await friendPage.locator('a[href^="/friends/"]').first().click()
  await friendPage.waitForURL(/\/friends\/\d+/, { timeout: 10000 })

  await friendPage.getByRole('tab', { name: 'Recipes' }).click()
  const renamed = `${recipeName} Renamed`
  await friendPage.locator(`a:has-text("${renamed}")`).first().click()
  await friendPage.waitForURL(/\/friends\/\d+\/recipes\/\d+/, { timeout: 10000 })
  await friendPage.locator('main', { hasText: 'Ingredients' }).waitFor({ timeout: 10000 })

  // Editing someone else's recipe would rewrite meals they already logged.
  if (await friendPage.locator('main input:not([readonly])').count()) {
    throw new Error('a friend’s recipe is editable')
  }

  await friendPage.getByRole('button', { name: 'Add recipe' }).click()
  // Not a bare /recipes/\d+ regex: the page we're leaving is
  // /friends/<id>/recipes/<id>, which matches it and returns immediately.
  await friendPage.waitForURL((url) => /\/recipes\/\d+$/.test(url.pathname) && !url.pathname.startsWith('/friends/'), {
    timeout: 15000,
  })
  // Waits on the editor's own field, not on the recipe name: the page being
  // left behind shows that name too, so matching it passes before the new
  // screen has rendered anything.
  const nameField = friendPage.locator('label:has-text("Name") input')
  await nameField.waitFor({ timeout: 10000 })
  if ((await nameField.inputValue()) !== renamed) {
    throw new Error(`copy is named ${await nameField.inputValue()}`)
  }

  // The copy is the friend's own, so unlike the original it can be edited.
  if ((await friendPage.locator('main input:not([readonly])').count()) === 0) {
    throw new Error('the copy is not editable')
  }
})

await step('turning a sharing switch off closes the door', async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  const toggle = page.locator('#sharing label').filter({ hasText: 'Recipes' }).locator('input')
  await toggle.click()
  await page.waitForTimeout(1200)

  await friendPage.goto(`${BASE}/friends`, { waitUntil: 'networkidle' })
  await friendPage.locator('a[href^="/friends/"]').first().click()
  await friendPage.waitForURL(/\/friends\/\d+/, { timeout: 10000 })
  await friendPage.waitForTimeout(900)
  const tabs = (await friendPage.locator('[role="tab"]').allInnerTexts()).map((t) => t.trim())
  if (tabs.includes('Recipes')) throw new Error(`recipes still offered: ${tabs.join('|')}`)

  await toggle.click()
  await page.waitForTimeout(900)
})

await step('a shared recipe link opens with no session at all', async () => {
  await page.goto(recipeUrl, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create link' }).click()
  const field = page.locator('input[aria-label="Public link to this recipe"]')
  await field.waitFor({ timeout: 10000 })
  const url = await field.inputValue()

  const anonymous = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const anonymousPage = await anonymous.newPage()
  anonymousPage.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`anon: ${m.text().slice(0, 160)}`)
  })
  await anonymousPage.goto(url, { waitUntil: 'networkidle' })
  await anonymousPage.locator('body', { hasText: 'Sign in to save' }).waitFor({ timeout: 10000 })

  const text = await anonymousPage.locator('body').innerText()
  if (!text.includes(`${recipeName} Renamed`)) throw new Error(text.slice(0, 300))
  // The private app shell must not follow a stranger onto this page.
  if (await anonymousPage.locator('nav.dock').count()) throw new Error('public page shows the dock')
})

await browser.close()

const unique = [...new Set(consoleErrors)].filter(
  (text) => !expectedConsoleErrors.some((pattern) => pattern.test(text)),
)
if (unique.length) {
  console.error(`\nBrowser console errors:\n${unique.map((e) => `  ${e}`).join('\n')}`)
}

if (failed || unique.length) {
  console.error(`\nFAILED${failed ? `: ${failed}` : ' (console errors)'}`)
  process.exit(1)
}
console.log('\nAll steps passed, no console errors.')
