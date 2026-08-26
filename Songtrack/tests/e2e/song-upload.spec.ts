import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// Upload lives in a modal opened from the navbar Upload button (left of Record).
// Each picked file becomes its own song with exactly one take; titles come from
// the filename minus its extension. The queue runs strictly one file at a time.
const FIXTURE = join(import.meta.dirname, 'fixtures', 'test-tone.wav')

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

async function openUploadModal(page) {
  await page.locator('header').getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByRole('heading', { name: 'Upload songs' })).toBeVisible()
}

test('multi-file upload via navbar modal creates one song per file', async ({ page }) => {
  await page.goto('/')

  await openUploadModal(page)

  const wav = readFileSync(FIXTURE).toString('base64')
  const dataTransfer = await page.evaluateHandle(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const dt = new DataTransfer()
    // Two distinct files under two names — must land as two separate songs.
    for (const name of ['Upload Song A.wav', 'Upload Song B.wav']) {
      dt.items.add(new File([bytes], name, { type: 'audio/wav' }))
    }
    return dt
  }, wav)

  const input = page.locator('.modal input[type="file"]')
  // The input allows choosing several files at once.
  expect(await input.evaluate(el => (el as HTMLInputElement).multiple)).toBe(true)
  await input.evaluate((el, dt) => {
    (el as HTMLInputElement).files = (dt as unknown as DataTransfer).files
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, dataTransfer)

  // Both queue items settle as done.
  await expect(page.locator('.modal li').filter({ hasText: 'Upload Song A' }).locator('.text-success')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.modal li').filter({ hasText: 'Upload Song B' }).locator('.text-success')).toBeVisible()

  // Each landed as a real, playable song page titled after the file.
  for (const title of ['Upload Song A', 'Upload Song B']) {
    await page.locator(`.modal a:text-is("${title}")`).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await page.goto('/')
  }

  // And both show up in the library as separate entries.
  await expect(page.locator('a', { hasText: 'Upload Song A' })).toBeVisible()
  await expect(page.locator('a', { hasText: 'Upload Song B' })).toBeVisible()
})
