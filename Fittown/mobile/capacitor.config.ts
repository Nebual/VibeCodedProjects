import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The server URL is baked in at build time (docs/samsung-health-sync.md §6):
 * this is a WebView shell for one self-hosted deployment, not a general
 * client, so there's no runtime "enter your server" screen. Set
 * FITTOWN_SERVER_URL before building; the placeholder below keeps a fresh
 * checkout buildable (if not useful) without it.
 */
const serverUrl = process.env.FITTOWN_SERVER_URL || 'https://fittown.nebtown.info'

const config: CapacitorConfig = {
  appId: 'com.fittown.app',
  appName: 'Fittown',
  // Unused when server.url is set below (nothing here is ever bundled into
  // the APK), but the CLI's sync step still expects the directory to exist.
  webDir: 'www',
  server: {
    url: serverUrl,
    // Only matters for a local dev server on a bare http:// LAN address —
    // the production deployment already speaks HTTPS.
    cleartext: serverUrl.startsWith('http://'),
  },
}

export default config
