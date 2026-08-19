import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

// These two tests share the one fixture song (there's only one song at this
// point in the suite) and run serially within this file (fullyParallel is
// off project-wide), so order matters: the test that depends on a pristine
// "noise reduction never enabled" state must run before the one that saves
// filters onto that same song.

test('denoise panel: "listen to what\'s removed" only appears once noise reduction is on, and the audition round-trip completes', async ({ page }) => {
  await page.goto('/')
  // /api/songs sorts newest-first, and the recorder e2e spec creates a new
  // song mid-suite — filter by the fixture's own title so a concurrently
  // running spec's song can never outrank it here.
  const [song] = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  await page.goto(`/songs/${song.id}/edit`)
  await expect(page.locator('.loading-spinner')).not.toBeVisible({ timeout: 10_000 })

  await expect(page.getByRole('button', { name: /Listen to what's removed/ })).not.toBeVisible()

  await page.getByLabel('Enable noise reduction').check()
  const auditionButton = page.getByRole('button', { name: /Listen to what's removed/ })
  await expect(auditionButton).toBeVisible()
  await auditionButton.click()
  // The button disables mid-flight (rendering + playing the audition clip)
  // and must come back to its idle label on its own — proves the whole
  // render → play → onended round-trip completes without getting stuck.
  await expect(auditionButton).toBeEnabled({ timeout: 20_000 })
  await expect(auditionButton).toHaveText(/Listen to what's removed/)
})

test('denoise panel: enabling noise reduction, previewing, and saving persists the filter', async ({ page }) => {
  await page.goto('/')
  // /api/songs sorts newest-first, and the recorder e2e spec creates a new
  // song mid-suite — filter by the fixture's own title so a concurrently
  // running spec's song can never outrank it here.
  const [song] = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  await page.goto(`/songs/${song.id}/edit`)
  await expect(page.locator('.loading-spinner')).not.toBeVisible({ timeout: 10_000 })

  const enableToggle = page.getByLabel('Enable noise reduction')
  await expect(enableToggle).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()

  await enableToggle.check()
  await expect(page.getByLabel('Noise reduction strength')).toBeVisible()

  // Fixture has no ambience lead-in, so the panel should say so and fall back to floor tracking.
  await expect(page.getByText(/No ambience sample was captured/)).toBeVisible()

  // Turning it on with no other edits is itself a save-worthy change.
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled()

  await page.getByRole('button', { name: 'Preview edits' }).click()
  await expect(page.locator('audio[controls]')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Save' }).click()
  // Save re-renders the full master with the real ffmpeg filter chain, which
  // can take longer than the default assertion timeout under a heavily
  // parallel test run (many concurrent ffmpeg renders competing for CPU).
  await expect(page).toHaveURL(new RegExp(`/songs/${song.id}$`), { timeout: 15_000 })

  const saved = await page.evaluate(id => fetch(`/api/songs/${id}`).then(r => r.json()), song.id as string)
  expect(saved.editList.filters).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'afftdn', nr: 10, gs: 6 })]),
  )
})
