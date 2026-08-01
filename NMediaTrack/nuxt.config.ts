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
      title: 'NMediaTrack',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'Track the games, shows, movies and books you are consuming — with whom, what you thought, and what to pick up next.',
        },
      ],
      script: [
        {
          // Applies the saved (or system-preferred) theme before first paint so
          // there's no flash of the wrong theme. Mirrors app/composables/useTheme.ts.
          innerHTML: `(function(){try{var t=localStorage.getItem('nmediatrack.theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t==='light'?'nord':'night')}catch(e){}})()`,
          tagPosition: 'head',
        },
      ],
    },
  },
})
