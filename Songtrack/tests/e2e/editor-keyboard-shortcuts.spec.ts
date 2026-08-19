import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

test('editor keyboard shortcuts: space toggles playback, Ctrl+Z undoes a crop', async ({ page }) => {
  await page.goto('/')
  // /api/songs sorts newest-first, and the recorder e2e spec creates a new
  // song mid-suite — filter by the fixture's own title so a concurrently
  // running spec's song can never outrank it here.
  const [song] = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  await page.goto(`/songs/${song.id}/edit`)

  const waveform = page.locator('.bg-base-300.rounded-box')
  await expect(page.locator('.loading-spinner')).not.toBeVisible({ timeout: 10_000 })

  const playButton = page.locator('button', { hasText: '▶' })
  await expect(playButton).toBeVisible()

  // Space toggles the editor's own waveform playback (not the persistent PlayerBar).
  await page.keyboard.press('Space')
  await expect(page.locator('button', { hasText: '⏸' })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.locator('button', { hasText: '▶' })).toBeVisible()

  // Crop a middle section, then undo it via Ctrl+Z instead of the toolbar button.
  const box = await waveform.boundingBox()
  if (!box) throw new Error('waveform container not found')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.3, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 10 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Remove selection' }).click()

  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
})
