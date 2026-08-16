import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: ['nuxt-auth-utils'],

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  app: {
    head: {
      title: 'Fittown',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#1d232a' },
        { name: 'description', content: 'Nutrition, water and fitness tracking' },
        // Let iOS run it fullscreen when added to the home screen.
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      ],
      link: [
        { rel: 'manifest', href: '/manifest.webmanifest' },
        // iOS Safari's "Add to Home Screen" reads this directly and ignores the manifest.
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
    },
  },

  runtimeConfig: {
    // Filled from NUXT_OAUTH_GOOGLE_CLIENT_ID / _SECRET at runtime.
    oauth: {
      google: {
        clientId: '',
        clientSecret: '',
        /**
         * Optional override for the OAuth callback URL
         * (NUXT_OAUTH_GOOGLE_REDIRECT_URL).
         *
         * Left empty, the callback URL is derived from the incoming request.
         * Behind a TLS-terminating reverse proxy the app is spoken to over
         * plain HTTP, so unless the proxy sends `X-Forwarded-Proto: https`
         * that derivation yields `http://…` and Google rejects the whole flow
         * with `redirect_uri_mismatch`. Fixing the proxy is the better answer;
         * this is here for when you can't, or don't want the flow depending on
         * a header you don't control.
         */
        redirectURL: '',
      },
    },
    // NUXT_SESSION_PASSWORD — must be >= 32 chars. See .env.example.
    session: {
      name: 'fittown',
      cookie: {
        sameSite: 'lax',
      },
    },
  },
})
