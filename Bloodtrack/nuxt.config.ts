import tailwindcss from '@tailwindcss/vite'
import process from 'process'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  buildDir: process.env.NUXT_BUILD_DIR || '.nuxt',
  devtools: { enabled: true },
  devServer: {
    host: '0.0.0.0',
  },
  vite: {
    plugins: [tailwindcss()],
  },
  css: ['~/assets/css/main.css'],
})
