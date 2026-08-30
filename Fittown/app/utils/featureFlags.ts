/**
 * Manual device pairing UI (docs/samsung-health-sync.md §3) — Settings'
 * "Connected devices" panel and login's "Have a pairing code instead?" link.
 *
 * Off for now: the app's own Google sign-in pairs itself automatically, so
 * this fallback (a second device, or re-pairing without Google) isn't
 * needed yet. Nothing underneath is removed — /api/devices/*, /pair, and the
 * fittown://pair deep link all stay live regardless, since the automatic
 * flow still lands on /pair to claim its code. Flip this back to show the
 * manual UI again.
 */
export const SHOW_DEVICE_PAIRING_UI = false
