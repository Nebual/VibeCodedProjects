import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: ['nuxt-auth-utils', '@vite-pwa/nuxt'],

  app: {
    head: {
      link: [{ rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icons/icon-192.png' }],
      meta: [{ name: 'theme-color', content: '#6419e6' }],
    },
  },

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  nitro: {
    experimental: {
      websocket: false,
    },
    externals: {
      // @tonejs/midi ships CommonJS under *both* its `main` and its (mislabelled) `module`
      // entry, so Nitro's dev ESM loader can't take `import { Midi }` from it. Bundling it
      // instead lets rollup's interop resolve the named export, in dev and in the build alike.
      inline: ['@tonejs/midi'],
    },
  },

  runtimeConfig: {
    dataDir: process.env.DATA_DIR || '.data',
    adminEmail: process.env.SONGTRACK_ADMIN_EMAIL || 'ben1120@gmail.com',
    session: {
      maxAge: 60 * 60 * 24 * 90, // 90 days
    },
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'Songtrack',
      short_name: 'Songtrack',
      description: 'Record, tag, and non-destructively edit piano recordings.',
      theme_color: '#6419e6',
      background_color: '#ffffff',
      display: 'standalone',
      start_url: '/',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      // This is a fully server-rendered app with no prerendered/static routes,
      // so there's no static index.html to serve as an offline navigation
      // fallback — @vite-pwa/nuxt's default `navigateFallback: '/'` would
      // point at a URL that was never precached and fail. Pages always need
      // the network; what's worth caching is the hashed, immutable JS/CSS
      // bundle, so a flaky connection doesn't force a full re-download on
      // every visit. Recordings are served dynamically from /api and never
      // touch the build output, so they're never a caching concern here.
      navigateFallback: null,
      runtimeCaching: [
        {
          urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/_nuxt/'),
          handler: 'CacheFirst',
          options: {
            cacheName: 'songtrack-static',
            expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
          },
        },
      ],
    },
    devOptions: {
      enabled: false,
    },
  },
})
