# web/public

Served at the site root by Nuxt, with no build step.

## Favicons

| File | Used for |
|---|---|
| `favicon-16.png` | browser tab at 1x |
| `favicon-32.png` | browser tab at 2x, bookmarks |
| `favicon-180.png` | iOS home screen (`apple-touch-icon`) |

Declared in `nuxt.config.ts` with explicit `sizes`, so browsers pick the right
one instead of downscaling the 180px image for a 16px tab.

To change the icon, replace these three files at the same dimensions. Browsers
cache favicons aggressively — a hard reload, or a private window, is usually
needed to see a change.
