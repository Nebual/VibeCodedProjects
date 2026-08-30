import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The server URL is baked in at build time (docs/samsung-health-sync.md §6):
 * this is a WebView shell for one self-hosted deployment, not a general
 * client, so there's no runtime "enter your server" screen. Set
 * FITTOWN_SERVER_URL before building; the placeholder below keeps a fresh
 * checkout buildable (if not useful) without it.
 */
const serverUrl = process.env.FITTOWN_SERVER_URL || 'https://fittown.example.com'

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
  android: {
    // Found on a real device, not predicted: a hand-rolled fix in
    // MainActivity.kt using View.setPadding() for the system-bar insets
    // didn't just fail to clear the nav bar — it actively broke SPA
    // navigation, rendering a fresh route's content *below* the previous
    // page's instead of replacing it. Padding insets a WebView's drawing
    // area without changing its measured size, and Chromium's viewport
    // math (min-h-dvh, in particular) doesn't reliably recompute across a
    // client-side route change when only that changes. Capacitor's own
    // edge-to-edge handling (CapacitorWebView.edgeToEdgeHandler(),
    // disabled by default) uses real Android margins instead — an actual
    // LayoutParams resize the WebView measures against before Chromium
    // renders anything, not a post-hoc inset — which is the difference
    // that matters here. 'force' rather than 'auto' so it isn't
    // conditional on Android-version/theme heuristics we don't control.
    adjustMarginsForEdgeToEdge: 'force',
  },
}

export default config

