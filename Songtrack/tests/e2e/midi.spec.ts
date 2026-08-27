import { expect, test } from '@playwright/test'

/**
 * Runs against the stub worker (`MIDI_FAKE_WORKER=true` in playwright.config.ts), which replays
 * `tests/e2e/fixtures/transcribe-stream.jsonl` — frames byte-shape-identical to the sidecar's.
 *
 * The `/sheets` round trip isn't covered here: it's MuseScore's output that matters and faking it
 * would test nothing. The re-quantization arithmetic underneath it is pure and unit-tested instead.
 */

/** The fixture song, resolved by name — `recorder.spec.ts` creates a song mid-suite that would
 *  otherwise outrank it in the newest-first list. */
async function fixtureSong(page: import('@playwright/test').Page): Promise<string> {
  const songs = await page.evaluate(() => fetch('/api/songs?q=test-tone').then(r => r.json()))
  expect(songs.length).toBeGreaterThan(0)
  return songs[0].id
}

test.beforeEach(async ({ page }) => {
  await page.goto('/api/_test-login')
})

test('transcribes a song, streaming progress and notes onto the roll', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)

  // networkidle before the first click: without it the click can race Vue hydration and
  // silently no-op, with no error and no crash.
  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })

  // Specs share one database, so this song may already carry a transcription from another spec.
  // Reveal the setup UI and pick an explicit instrument: a different instrument set is a different
  // cache key, which forces a real streamed run rather than a cache hit.
  const again = page.getByTestId('transcribe-again')
  if (await again.count()) await again.click()
  await page.getByRole('button', { name: 'chromatic percussion' }).click()

  await page.getByTestId('start-transcription').click()

  await expect(page.getByTestId('piano-roll')).toBeVisible()
  await expect(page.getByTestId('progress-pct')).toHaveText('100%', { timeout: 30_000 })

  // The results card only appears once the finished roll has been redrawn from the saved events.
  await expect(page.getByTestId('tempo-editor')).toBeVisible()
  await expect(page.getByTestId('download-score-midi')).toBeVisible()
  await expect(page.getByTestId('transcribe-error')).toHaveCount(0)

  const notes = await page.evaluate((id) =>
    fetch(`/api/songs/${id}/transcription/events`).then(r => r.json()), songId)
  expect(notes.notes.length).toBe(8)
  // The saved events are de-lagged; the streamed ones were 21 ms late.
  expect(notes.notes[0].start).toBeCloseTo(0, 3)
  expect(notes.beatGrid).toMatchObject({ bpm: 120, beatsPerBar: 4 })
})

test('a revisit shows the finished roll without re-running the model', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)

  // Make sure a transcription exists before timing the cached one.
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })

  // No Start button on a revisit — it goes straight to the results.
  await expect(page.getByTestId('tempo-editor')).toBeVisible()
  await expect(page.getByTestId('piano-roll')).toBeVisible()
  await expect(page.getByTestId('start-transcription')).toHaveCount(0)

  // Frame count, not wall-clock: a cache hit synthesises exactly one progress frame and one
  // transcription_complete off the disk, where a live run replays the stub's 26. That's a
  // deterministic signal that the model was not re-run, and it can't flake under load.
  const frames = await page.evaluate(async (id) => {
    const body = await fetch(`/api/songs/${id}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruments: [] }),
    }).then(r => r.text())
    return (body.match(/^data:/gm) || []).length
  }, songId)
  expect(frames, 'a cached transcription must not re-run the worker').toBe(2)
})

test('offers both MIDI downloads, and the score one is a real MIDI file', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('download-performance-midi')).toBeVisible()

  for (const variant of ['score', 'performance']) {
    const head = await page.evaluate(async ([id, v]) => {
      const res = await fetch(`/api/songs/${id}/transcription/midi?variant=${v}&bpm=120&beatsPerBar=4&firstDownbeat=0&subdivision=4`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return String.fromCharCode(...bytes.slice(0, 4))
    }, [songId, variant])
    expect(head, `${variant} MIDI header`).toBe('MThd')
  }
})

test('the tempo editor recomputes onset error locally, with no server round trip', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('tempo-editor')).toBeVisible()

  // The fixture is perfectly on the grid at 120 bpm, so the error starts at zero.
  await expect(page.getByTestId('onset-error')).toContainText('0 ms')

  let serverCalls = 0
  await page.route('**/api/songs/**', (route) => { serverCalls++; route.continue() })

  await page.getByTestId('bpm-halve').click()
  await expect(page.getByTestId('bpm-input')).toHaveValue('60')
  await page.getByTestId('bpm-double').click()
  await expect(page.getByTestId('bpm-input')).toHaveValue('120')

  expect(serverCalls, 'tempo edits must not hit the server').toBe(0)
})
