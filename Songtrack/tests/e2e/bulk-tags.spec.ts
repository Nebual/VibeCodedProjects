import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

// The song list sorts newest-first, and the recorder e2e spec creates a new
// song mid-suite — searching for the fixture's own title keeps the list down
// to exactly one deterministic row, immune to a concurrently running spec's
// song outranking it.
async function goToFixtureOnlyList(page: import('@playwright/test').Page) {
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByPlaceholder('Search songs…').fill('test-tone')
  await expect(page.locator('li.card')).toHaveCount(1)
}

test('bulk tag editing: adding a tag to a selected song is visible without a page reload', async ({ page }) => {
  await goToFixtureOnlyList(page)

  await page.getByRole('button', { name: 'Select' }).click()
  const row = page.locator('li.card').first()
  await row.locator('input[type="checkbox"]').check()
  await expect(page.getByText('1 selected')).toBeVisible()

  await page.getByPlaceholder('Add tags…').fill('e2ebulktag1')
  await page.getByPlaceholder('Add tags…').press('Enter')
  await page.getByRole('button', { name: /^Add tags?$/ }).click()

  // Selection UI closes and the new tag shows up on the row it was applied to.
  await expect(page.getByText('1 selected')).not.toBeVisible()
  await expect(row.getByText('e2ebulktag1')).toBeVisible()

  // It's also now a usable filter chip, proving the tag row itself was created.
  await expect(page.getByRole('button', { name: 'e2ebulktag1' })).toBeVisible()
})

test('bulk tag editing: removing a tag from a selected song', async ({ page }) => {
  await goToFixtureOnlyList(page)
  const row = page.locator('li.card').first()

  // Self-contained: add the tag first, then remove it, so this test doesn't
  // depend on the other test's execution order.
  await page.getByRole('button', { name: 'Select' }).click()
  await row.locator('input[type="checkbox"]').check()
  await page.getByPlaceholder('Add tags…').fill('e2ebulktag2')
  await page.getByPlaceholder('Add tags…').press('Enter')
  await page.getByRole('button', { name: /^Add tags?$/ }).click()
  await expect(row.getByText('e2ebulktag2')).toBeVisible()

  await page.getByRole('button', { name: 'Select' }).click()
  await row.locator('input[type="checkbox"]').check()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByPlaceholder('Add tags…').fill('e2ebulktag2')
  await page.getByPlaceholder('Add tags…').press('Enter')
  await page.getByRole('button', { name: /^Remove tags?$/ }).click()

  await expect(page.getByText('1 selected')).not.toBeVisible()
  await expect(row.getByText('e2ebulktag2')).not.toBeVisible()
})
