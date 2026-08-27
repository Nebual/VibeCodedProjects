import { expect, test } from '@playwright/test'

/**
 * The YouTube tab of the upload modal.
 *
 * Deliberately stops short of a real import: that would shell out to yt-dlp and hit
 * youtube.com, making the suite network-dependent, slow, and prone to breaking whenever
 * YouTube changes something. What's covered here is the part that is genuinely ours — tab
 * switching, client-side link validation, and that a valid paste turns into queue items
 * against the right endpoint. The request itself is intercepted, so no download ever starts.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

async function openYoutubeTab(page: import('@playwright/test').Page) {
  // waitUntil: 'networkidle' matters here — without it the click races Vue hydration and
  // silently does nothing, leaving the modal closed. Same gotcha as the other specs.
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByRole('heading', { name: 'Upload songs' })).toBeVisible()
  await page.locator('.modal').getByRole('tab', { name: 'YouTube' }).click()
  return page.locator('.modal').getByLabel('YouTube links')
}

test('the file picker and the YouTube box are separate tabs', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: 'Upload' }).click()

  const modal = page.locator('.modal')
  // Files is the default tab, so the existing upload flow is unchanged.
  await expect(modal.locator('input[type="file"]')).toBeVisible()
  await expect(modal.getByLabel('YouTube links')).toBeHidden()

  await modal.getByRole('tab', { name: 'YouTube' }).click()
  await expect(modal.getByLabel('YouTube links')).toBeVisible()
  await expect(modal.locator('input[type="file"]')).toBeHidden()

  await modal.getByRole('tab', { name: 'Files' }).click()
  await expect(modal.locator('input[type="file"]')).toBeVisible()
})

test('a non-YouTube link is refused in the browser, before any request goes out', async ({ page }) => {
  let requested = false
  await page.route('**/api/songs/import-youtube', async (route) => {
    requested = true
    await route.abort()
  })

  const box = await openYoutubeTab(page)
  await box.fill('https://vimeo.com/12345')
  await page.locator('.modal').getByRole('button', { name: 'Import' }).click()

  await expect(page.locator('.modal .text-error').first()).toContainText(/only youtube links/i)
  expect(requested).toBe(false)
  // The bad line stays put so it can be corrected rather than retyped.
  await expect(box).toHaveValue('https://vimeo.com/12345')
})

test('a playlist link is refused with a message that says why', async ({ page }) => {
  const box = await openYoutubeTab(page)
  await box.fill('https://www.youtube.com/playlist?list=PL1234567890')
  await page.locator('.modal').getByRole('button', { name: 'Import' }).click()

  await expect(page.locator('.modal .text-error').first()).toContainText(/playlist/i)
})

test('a multi-line paste queues one item per link, one request at a time', async ({ page }) => {
  const seenUrls: string[] = []
  let inFlight = 0
  let maxConcurrent = 0

  await page.route('**/api/songs/import-youtube', async (route) => {
    inFlight++
    maxConcurrent = Math.max(maxConcurrent, inFlight)
    const body = route.request().postDataJSON() as { url: string }
    seenUrls.push(body.url)
    // Stand in for a real import so no yt-dlp process or network fetch happens.
    await new Promise(r => setTimeout(r, 150))
    inFlight--
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: `fake-${seenUrls.length}`, title: `Video ${seenUrls.length}` }),
    })
  })

  const box = await openYoutubeTab(page)
  await box.fill([
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'https://youtu.be/bbbbbbbbbbb',
    // The same video a second time, in the other url form — must not import twice.
    'https://www.youtube.com/watch?v=bbbbbbbbbbb',
  ].join('\n'))
  await page.locator('.modal').getByRole('button', { name: 'Import' }).click()

  const items = page.locator('.modal ul li')
  await expect(items).toHaveCount(2)

  // Titles are replaced by what the server reports once each import finishes.
  await expect(page.locator('.modal li').filter({ hasText: 'Video 1' }).locator('.text-success'))
    .toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.modal li').filter({ hasText: 'Video 2' }).locator('.text-success'))
    .toBeVisible()

  expect(seenUrls).toHaveLength(2)
  // Concurrency 1 is the whole point of the queue — a paste of twenty links must not start
  // twenty downloads and twenty ffmpeg renders at once.
  expect(maxConcurrent).toBe(1)
  // A fully-accepted paste clears the box.
  await expect(box).toHaveValue('')
})

test('a failed import shows the server\'s own explanation and can be retried', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/songs/import-youtube', async (route) => {
    attempts++
    if (attempts === 1) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 502, statusMessage: 'That video is longer than the 60 minute import limit.' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'fake-ok', title: 'Recovered Video' }),
    })
  })

  const box = await openYoutubeTab(page)
  await box.fill('https://youtu.be/ccccccccccc')
  await page.locator('.modal').getByRole('button', { name: 'Import' }).click()

  // The useful part is the server's message, not "[POST] ... 502 Bad Gateway".
  await expect(page.locator('.modal li .text-error').filter({ hasText: 'longer than the 60 minute' }))
    .toBeVisible({ timeout: 30_000 })

  await page.locator('.modal li').getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.modal li').filter({ hasText: 'Recovered Video' }).locator('.text-success'))
    .toBeVisible({ timeout: 30_000 })
})
