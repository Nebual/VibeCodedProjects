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
      link: [{ rel: 'manifest', href: '/manifest.webmanifest' }],
    },
  },

  runtimeConfig: {
    // Filled from NUXT_OAUTH_GOOGLE_CLIENT_ID / _SECRET at runtime.
    oauth: {
      google: {
        clientId: '',
        clientSecret: '',
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
