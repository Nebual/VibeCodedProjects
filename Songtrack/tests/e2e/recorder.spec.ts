import { expect, test } from '@playwright/test'

// Fake mic device + permissions are configured project-wide in playwright.config.ts.

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

test('the rolling waveform shows real amplitude variation while recording', async ({ page }) => {
  await page.goto('/record', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Record' }).click()

  // The fixture tone has a ~1.5s volume cycle — give it a couple of cycles.
  await page.waitForTimeout(4000)

  // Regression test: takes pushed into the reactive `takes` array were then
  // mutated through the original plain-object reference, so Vue never saw
  // the RMS data change and the canvas stayed on its first (empty) render.
  const barHeights = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (!canvas) return null
    const ctx = canvas.getContext('2d')!
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const heights: number[] = []
    const step = Math.max(1, Math.floor(width / 30))
    for (let x = 0; x < width; x += step) {
      let top = height // fully transparent column reads as height (no bar)
      for (let y = 0; y < height; y++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          top = y
          break
        }
      }
      heights.push(height - top) // bar height in pixels
    }
    return heights
  })

  expect(barHeights).not.toBeNull()
  const distinctHeights = new Set(barHeights)
  // A flat/blank canvas draws every sampled column at the same height.
  expect(distinctHeights.size).toBeGreaterThan(2)
})
