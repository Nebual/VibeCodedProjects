<script setup lang="ts">
import type { TagSymbol } from '#shared/tags'

// Drawn inline rather than pulled from an icon set. Every icon in this app is a hand-rolled
// SVG and there is no icon package installed, so `i-mdi-store-remove` would mean adding a
// dependency and a build step to render two glyphs. This is the MDI storefront-with-a-minus
// idea, redrawn in the stroke weight the rest of the toolbar uses.
defineProps<{ symbol: TagSymbol }>()
</script>

<template>
  <svg
    v-if="symbol === 'star'"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 3.6l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.87l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85z" />
  </svg>

  <svg
    v-else
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <!-- Awning, then the two walls the minus badge doesn't cover. -->
    <path d="M3 4.5h18l-1 5.5H4z" stroke-linejoin="round" />
    <path d="M5 10v9h7M19 10v2" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="17.5" cy="17.5" r="4.5" />
    <path d="M15.4 17.5h4.2" stroke-linecap="round" />
  </svg>
</template>
