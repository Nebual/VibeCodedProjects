import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

test('global player shortcuts: space toggles play/pause, arrows skip 10s', async ({ page }) => {
  await page.goto('/')
  // /api/songs sorts newest-first, and the recorder e2e spec creates a new
  // song mid-suite — filter by the fixture's own title so a concurrently
  // running spec's song can never outrank it here.
  const [song] = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  // waitUntil: 'networkidle' matters here — without it the click can race Vue
  // hydration and silently no-op (see AGENTS.md's recorder-spec note).
  await page.goto(`/songs/${song.id}`, { waitUntil: 'networkidle' })

  await page.getByRole('button', { name: 'Play' }).click()
  const playerBar = page.locator('.fixed.bottom-0')
  await expect(playerBar).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible()

  await page.keyboard.press('Space')
  await expect(page.getByRole('button', { name: 'Play' }).first()).toBeVisible()

  const seekBar = playerBar.getByRole('slider', { name: 'Seek' })
  const before = Number(await seekBar.inputValue())
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => Number(await seekBar.inputValue())).toBeGreaterThan(before + 5)

  const afterForward = Number(await seekBar.inputValue())
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => Number(await seekBar.inputValue())).toBeLessThan(afterForward - 5)
})

test('typing in a text field is not intercepted by the space/arrow shortcuts', async ({ page }) => {
  await page.goto('/')
  // /api/songs sorts newest-first, and the recorder e2e spec creates a new
  // song mid-suite — filter by the fixture's own title so a concurrently
  // running spec's song can never outrank it here.
  const [song] = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  // waitUntil: 'networkidle' matters here — without it the click can race Vue
  // hydration and silently no-op (see AGENTS.md's recorder-spec note).
  await page.goto(`/songs/${song.id}`, { waitUntil: 'networkidle' })

  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible()

  const titleInput = page.getByLabel('Title')
  await titleInput.click()
  await titleInput.press('End')
  await titleInput.pressSequentially(' abc')

  // Still playing — the space keystroke went into the field, not the shortcut handler.
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible()
  await expect(titleInput).toHaveValue(`${song.title} abc`)
})
