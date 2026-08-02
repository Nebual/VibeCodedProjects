import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

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
