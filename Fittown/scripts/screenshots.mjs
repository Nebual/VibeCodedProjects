import { chromium } from 'playwright'

const OUT = process.argv[2] || '/tmp/shots'
const BASE = 'http://localhost:3000'

const browser = await chromium.launch()

// iPhone-ish viewport — the primary target for this app.
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'light',
})

// Sign in once; the session cookie is reused for every shot.
const page = await mobile.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.screenshot({ path: `${OUT}/00-login.png` })

await page.getByRole('button', { name: /Sign in as Dev User/i }).click()
await page.waitForURL(`${BASE}/`, { timeout: 15000 })
await page.waitForLoadState('networkidle')

const shots = [
  ['01-diary', '/'],
  ['02-add', '/add?meal=breakfast'],
  ['03-fitness', '/fitness'],
  ['04-trends', '/trends'],
  ['05-settings', '/settings'],
  ['06-food-new', '/food/new'],
]

for (const [name, path] of shots) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
}

// The activity category grid, and one activity's effort picker.
await page.goto(`${BASE}/fitness`, { waitUntil: 'networkidle' })
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/03b-activity-categories.png`, fullPage: true })

await page.getByPlaceholder('Search activities').fill('Running')
await page.waitForTimeout(1100)
const runResult = page.locator('ul li button:has-text("Running")').first()
if (await runResult.count()) {
  await runResult.click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/03c-effort-levels.png`, fullPage: true })
}

// Trends, year view — a different layout, not just a wider range.
await page.goto(`${BASE}/trends`, { waitUntil: 'networkidle' })
await page.getByRole('tab', { name: '1y' }).click()
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/04b-trends-year.png`, fullPage: true })

// The calorie target calculator, if the profile is complete enough to open it.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await page.waitForTimeout(500)
const calculate = page.getByRole('button', { name: /Calculate calorie target/i })
if (!(await calculate.isDisabled())) {
  await calculate.click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/05b-calorie-target.png` })
  await page.keyboard.press('Escape')
}

// Search interaction
await page.goto(`${BASE}/add?meal=lunch`, { waitUntil: 'networkidle' })
await page.getByPlaceholder('Search foods').fill('peanut butter')
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/07-search.png`, fullPage: true })

// Food detail / portion picker
await page.goto(`${BASE}/food/170494?meal=breakfast`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/08-portion.png`, fullPage: true })

// Expanded micronutrients on the diary
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /Full nutrition/i }).click()
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/09-micros.png`, fullPage: true })

// Dark mode
const dark = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  colorScheme: 'dark',
  storageState: await mobile.storageState(),
})
const dp = await dark.newPage()
await dp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await dp.waitForTimeout(400)
await dp.screenshot({ path: `${OUT}/10-diary-dark.png`, fullPage: true })

// Desktop
const desktop = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  storageState: await mobile.storageState(),
})
const dtp = await desktop.newPage()
await dtp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await dtp.waitForTimeout(400)
await dtp.screenshot({ path: `${OUT}/11-desktop.png` })

await browser.close()

console.log(errors.length ? `CONSOLE ERRORS:\n${[...new Set(errors)].join('\n')}` : 'No console errors.')
