import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

// Regression test: the ambience region is captured against the full original recording, but a
// crop removing that same span meant Save/Preview rendered off a shorter, shifted chain than the
// region's own coordinates — self-extracting garbage (or nothing at all) as the "noise profile"
// and producing a 0-byte preview / a Save that 500'd when ffprobe couldn't read the broken output.
test('cropping away the ambience region does not break Preview edits or Save', async ({ page }) => {
  await page.goto('/')
  // /api/songs sorts newest-first, and the recorder e2e spec creates a new song mid-suite —
  // filter by the fixture's own title so a concurrently running spec's song can never outrank it.
  const [song] = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  await page.goto(`/songs/${song.id}/edit`)
  await expect(page.locator('.loading-spinner')).not.toBeVisible({ timeout: 10_000 })

  const waveform = page.locator('.bg-base-300.rounded-box')
  const box = await waveform.boundingBox()
  if (!box) throw new Error('waveform container not found')
  const y = box.y + box.height / 2

  // Crop away the whole middle of the clip first (15%-85%), leaving only the first/last 15% —
  // a ~3s chain out of a 10s clip. The gap is wide and generously clear of either remaining
  // "keep" region's edge handle (at 15% and 85%).
  await page.mouse.move(box.x + box.width * 0.15, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.85, y, { steps: 5 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Remove selection' }).click()

  await page.getByLabel('Enable noise reduction').check()

  // Select an ambience region deep inside the now-cropped-away middle (40%-50% of the original
  // timeline) — its absolute position is well past the ~3s the cropped render actually spans,
  // which is exactly the scenario that broke: extracting the ambience clip using the region's
  // original, un-translated coordinates against a shorter, shifted chain.
  await page.getByRole('button', { name: 'Select ambience' }).click()
  await page.mouse.move(box.x + box.width * 0.4, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Preview edits' }).click()
  const previewAudio = page.locator('audio[controls]')
  await expect(previewAudio).toBeVisible({ timeout: 15_000 })
  const previewSrc = await previewAudio.getAttribute('src')
  const previewByteLength = await page.evaluate(
    url => fetch(url).then(r => r.arrayBuffer()).then(b => b.byteLength),
    previewSrc!,
  )
  expect(previewByteLength).toBeGreaterThan(1000)

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(new RegExp(`/songs/${song.id}$`), { timeout: 15_000 })
})
