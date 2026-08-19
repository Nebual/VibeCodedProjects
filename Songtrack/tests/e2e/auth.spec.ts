import { expect, test } from '@playwright/test'

test.describe('auth gating', () => {
  test('an unauthenticated visit to the home page redirects to login', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByText('Sign in with Google')).toBeVisible()
  })

  test('an unauthenticated visit to the recorder redirects to login', async ({ page }) => {
    await page.goto('/record')
    await expect(page).toHaveURL(/\/login$/)
  })
})
