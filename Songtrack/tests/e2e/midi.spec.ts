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
  // Specs share one database, so this song may already carry a transcription. The page always
  // forces a re-run, so this streams for real either way — which is what makes the live-preview
  // assertions below deterministic rather than racing a 50 ms cache hit.
  const again = page.getByTestId('transcribe-again')
  if (await again.count()) await again.click()
  await page.getByTestId('instrument-search').fill('chromatic')
  await page.getByTestId('instrument-option-chromatic_percussion').click()

  await page.getByTestId('start-transcription').click()

  await expect(page.getByTestId('piano-roll')).toBeVisible()

  // The preview has to be usable *while* the run is still going — that's the whole point of it.
  await expect(page.getByTestId('crossfade-player')).toBeVisible()
  await expect(page.getByTestId('crossfade-toggle')).toHaveText('Preview so far')

  await expect(page.getByTestId('progress-pct')).toHaveText('100%', { timeout: 30_000 })
  // ...and reverts to the both-at-once label once there is a finished transcription to compare.
  await expect(page.getByTestId('crossfade-toggle')).toHaveText('Play both')

  // The results card only appears once the finished roll has been redrawn from the saved events.
  await expect(page.getByTestId('tempo-editor')).toBeVisible()
  await expect(page.getByTestId('download-score-midi')).toBeVisible()
  await expect(page.getByTestId('transcribe-error')).toHaveCount(0)

  const notes = await page.evaluate((id) =>
    fetch(`/api/songs/${id}/transcription/events`).then(r => r.json()), songId)
  expect(notes.notes.length).toBe(20) // 16 piano + 4 bass
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

test('the roll zooms to a window, and clicking it moves playback', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('piano-roll')).toBeVisible()

  // Zoom has to redraw immediately, with nothing playing — compare the canvas pixels rather
  // than trusting that a class changed.
  const pixels = () => page.evaluate(() => {
    const c = document.querySelector('[data-testid=\"piano-roll\"]') as HTMLCanvasElement
    return c.toDataURL().length + ':' + c.toDataURL().slice(-64)
  })
  await page.getByTestId('zoom-All').click()
  const all = await pixels()
  await page.getByTestId('zoom-5s').click()
  const five = await pixels()
  expect(five, 'zooming must redraw the roll even when nothing is playing').not.toBe(all)
  await page.getByTestId('zoom-30s').click()
  expect(await pixels()).not.toBe(five)

  // Clicking the roll seeks: the player's scrubber should follow it.
  const roll = page.getByTestId('piano-roll')
  const box = (await roll.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2)
  await expect.poll(async () => Number(await page.getByTestId('seek').inputValue()))
    .toBeGreaterThan(1)
})

test('each instrument can be switched off in the preview', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })

  // The fixture carries piano and bass, so both chips are offered.
  const piano = page.getByTestId('mute-acoustic_piano')
  const bass = page.getByTestId('mute-acoustic_bass')
  await expect(piano).toBeVisible()
  await expect(bass).toBeVisible()

  await expect(piano).toHaveClass(/btn-primary/)
  await piano.click()
  await expect(piano).not.toHaveClass(/btn-primary/)
  await bass.click()
  await expect(bass).not.toHaveClass(/btn-primary/)
  // Toggling back on is symmetric.
  await piano.click()
  await expect(piano).toHaveClass(/btn-primary/)
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

test('instruments are chosen from a searchable list, not a wall of chips', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })

  const again = page.getByTestId('transcribe-again')
  if (await again.count()) await again.click()

  const search = page.getByTestId('instrument-search')
  await expect(search).toBeVisible()

  // Nothing is listed until the box is focused — that's the point of replacing 35 chips.
  await expect(page.getByTestId('instrument-option-acoustic_piano')).toHaveCount(0)

  await search.click()
  await expect(page.getByTestId('instrument-option-acoustic_piano')).toBeVisible()

  // Typing filters, and matches on the spaced label as well as the underscored name.
  await search.fill('sax')
  await expect(page.getByTestId('instrument-option-tenor_sax')).toBeVisible()
  await expect(page.getByTestId('instrument-option-acoustic_piano')).toHaveCount(0)
  await search.fill('electric bass')
  await expect(page.getByTestId('instrument-option-electric_bass')).toBeVisible()

  // Enter picks the highlighted match and clears the box for the next one.
  await search.press('Enter')
  await expect(page.getByTestId('instrument-selected-electric_bass')).toBeVisible()
  await expect(search).toHaveValue('')

  // An already-chosen instrument drops out of the list rather than being offered twice.
  await search.fill('electric bass')
  await expect(page.getByTestId('instrument-option-electric_bass')).toHaveCount(0)

  // Backspace on an empty box removes the last choice.
  await search.fill('')
  await search.press('Backspace')
  await expect(page.getByTestId('instrument-selected-electric_bass')).toHaveCount(0)
})

test('the estimated-tempo banner goes away once the tempo is edited', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('tempo-editor')).toBeVisible()

  const banner = page.locator('.alert-warning')
  // The stub's grid comes back with beats_per_bar null and a detected bpm, so no banner. If a
  // future fixture changes that, the point still holds: editing must clear it.
  if (await banner.count()) {
    await page.getByTestId('bpm-double').click()
    // It must not sit there quoting the number the user just typed and calling it a guess.
    await expect(banner).toHaveCount(0)
  }
})

test('the BPM field can be typed into, and the downbeat snaps to a whole beat', async ({ page }) => {
  await page.goto('/')
  const songId = await fixtureSong(page)
  await page.evaluate(id => fetch(`/api/songs/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: [] }),
  }).then(r => r.text()), songId)

  await page.goto(`/songs/${songId}/midi`, { waitUntil: 'networkidle' })
  const bpm = page.getByTestId('bpm-input')

  // Typing "81" used to clamp the intermediate "8" up to the minimum, leaving "201".
  await bpm.click()
  await bpm.press('Control+a')
  await bpm.pressSequentially('81', { delay: 60 })
  await expect(bpm).toHaveValue('81')
  await bpm.blur()
  await expect(bpm).toHaveValue('81')

  // A downbeat must land on a whole beat: a sub-beat one slides the barlines between the notes
  // and syncopates the whole piece, which fills the engraving with ties.
  await page.getByTestId('pick-downbeat').click()
  const box = (await page.getByTestId('piano-roll').boundingBox())!
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2)
  const seconds = Number.parseFloat(await page.getByTestId('pick-downbeat').innerText())
  const beat = 60 / 81
  expect(Math.abs(seconds / beat - Math.round(seconds / beat))).toBeLessThan(0.02)
})
