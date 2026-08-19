import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

test('the edit page is a distinct page from the song detail page', async ({ page }) => {
  await page.goto('/')

  const firstSong = page.locator('a[href^="/songs/"]').first()
  await expect(firstSong).toBeVisible()
  await firstSong.click()
  await expect(page).toHaveURL(/\/songs\/[^/]+$/)

  const detailTitle = await page.locator('h1').first().textContent()
  await expect(page.getByText('Save changes')).toBeVisible()

  // Regression test: songs/[id].vue + songs/[id]/edit.vue used to collide as
  // an implicit Nuxt parent/child route (no <NuxtPage/> in the parent), so
  // the edit URL silently rendered the detail page's content instead.
  await page.getByRole('link', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/songs\/[^/]+\/edit$/)

  const editTitle = await page.locator('h1').first().textContent()
  expect(editTitle).toContain('Edit')
  expect(editTitle).not.toEqual(detailTitle)
  await expect(page.getByText('Save changes')).not.toBeVisible()
  await expect(page.getByText('Auto-trim')).toBeVisible()
})

test('direct navigation to the edit URL also renders the editor, not the detail page', async ({ page }) => {
  await page.goto('/') // establishes an authenticated page to fetch from
  const [song] = await page.evaluate(() => fetch('/api/songs').then(r => r.json()))

  await page.goto(`/songs/${song.id}/edit`)
  await expect(page.getByText('Auto-trim')).toBeVisible()
  await expect(page.getByText('Save changes')).not.toBeVisible()
})
