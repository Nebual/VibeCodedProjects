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

  nitro: {
    experimental: {
      websocket: false,
    },
  },

  runtimeConfig: {
    dataDir: process.env.DATA_DIR || '.data',
    adminEmail: process.env.SONGTRACK_ADMIN_EMAIL || 'ben1120@gmail.com',
    session: {
      maxAge: 60 * 60 * 24 * 90, // 90 days
    },
  },

})
