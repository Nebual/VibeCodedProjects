import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  app: {
    head: {
      title: 'NShoppingList',
      viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
      meta: [
        { name: 'description', content: 'A shared grocery list that syncs between devices.' },
      ],
      script: [
        {
          // Applies a saved light/dark override before first paint, so an explicit choice
          // never flashes the OS theme first. Mirrors DAISY_THEME in useTheme.ts.
          innerHTML: `try{var t=localStorage.getItem('nshoppinglist:theme');`
            + `if(t==='light'||t==='dark')document.documentElement.dataset.theme=t==='dark'?'dim':'emerald'}catch(e){}`,
          tagPosition: 'head',
        },
      ],
    },
  },
})
