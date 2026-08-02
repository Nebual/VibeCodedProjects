import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  app: {
    head: {
      title: 'NAudioBooker',
      link: [
        // Served from web/public. Several sizes because browsers pick per
        // context: 16/32 for the tab and bookmarks bar, 180 for an iOS home
        // screen shortcut, where a 32px icon would look like a smudge.
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/favicon-180.png' },
      ],
    },
  },

  css: ['~/assets/css/main.css'],

  // Tailwind v4 is wired in as a Vite plugin. Do not add @nuxtjs/tailwindcss:
  // that module targets v3 and its config-file model conflicts with v4's
  // CSS-first setup.
  vite: {
    plugins: [tailwindcss()],
  },

  runtimeConfig: {
    // Server-side only. The browser never talks to FastAPI directly; it goes
    // through the /api/** proxy in server/api so everything is same-origin.
    //
    // NAB_API_BASE is read at build time. To override a built image at run
    // time use NUXT_API_BASE, which Nuxt maps onto this key automatically.
    apiBase: process.env.NAB_API_BASE || 'http://127.0.0.1:8000',
  },
})
