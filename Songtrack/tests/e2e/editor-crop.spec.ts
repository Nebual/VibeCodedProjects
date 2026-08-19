import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

test('dragging a selection that starts inside the existing keep region works', async ({ page }) => {
  await page.goto('/')
  const [song] = await page.evaluate(() => fetch('/api/songs').then(r => r.json()))
  await page.goto(`/songs/${song.id}/edit`)

  const waveform = page.locator('.bg-base-300.rounded-box')
  await expect(page.locator('.loading-spinner')).not.toBeVisible({ timeout: 10_000 })

  const box = await waveform.boundingBox()
  if (!box) throw new Error('waveform container not found')

  // Regression test: every region element sets pointer-events:all on itself,
  // which used to swallow drag-selection's own pointerdown whenever the drag
  // started on top of the default full-width "keep" region — i.e. always,
  // since that region covers the entire waveform until something is cut.
  // Drag from 30% to 60% across the waveform, starting well inside it.
  const startX = box.x + box.width * 0.3
  const endX = box.x + box.width * 0.6
  const y = box.y + box.height / 2

  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(endX, y, { steps: 10 })
  await page.mouse.up()

  await expect(page.getByRole('button', { name: 'Remove selection' })).toBeVisible()

  await page.getByRole('button', { name: 'Remove selection' }).click()
  await expect(page.getByRole('button', { name: 'Remove selection' })).not.toBeVisible()

  // Cutting a middle section out enables Preview/Save (edit_list now differs from the saved one).
  await expect(page.getByRole('button', { name: 'Preview edits' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()
})
