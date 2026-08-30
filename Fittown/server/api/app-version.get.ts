import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * What the phone app should be running, per mobile/version.json — the same
 * file app/build.gradle reads to set versionName. The app compares this
 * against its own installed version (via @capacitor/app's App.getInfo()) to
 * show a "there's a newer build" nag. See docs/samsung-health-sync.md §6/§7.
 *
 * No session required — this is the one thing an out-of-date, possibly
 * already-broken app install still needs to be able to ask, unauthenticated.
 */
export default defineEventHandler(() => {
  try {
    const text = readFileSync(resolve(process.cwd(), 'mobile/version.json'), 'utf-8')
    const { version } = JSON.parse(text) as { version?: string }
    return { version: version ?? null }
  } catch {
    // mobile/version.json doesn't exist on this deployment (the mobile app
    // was never set up here) — not an error, just nothing to compare against.
    return { version: null }
  }
})
