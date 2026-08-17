<script setup lang="ts">
/**
 * Inline icon set.
 *
 * Hand-rolled rather than pulled from an icon package: the app needs a dozen
 * glyphs, and inlining them keeps the bundle free of an icon dependency and
 * avoids a font/sprite request on a phone.
 */
const props = defineProps<{ name: string }>()

const paths: Record<string, string> = {
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z',
  activity: 'm22 12-4 0-3 9L9 3l-3 9-4 0',
  chart: 'M3 3v18h18M18 9l-5 5-3-3-4 4',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  barcode: 'M3 5v14M7 5v14M11 5v10M15 5v14M19 5v14',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6',
  chevronLeft: 'm15 18-6-6 6-6',
  chevronRight: 'm9 18 6-6-6-6',
  droplet: 'M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0L12 2.7Z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'm20 6-11 11-5-5',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  scale: 'M12 3v18M8 21h8M6 8h12l3 8a5 5 0 0 1-6 0l3-8M3 16l3-8',
  ruler: 'M3 15 15 3l6 6L9 21l-6-6ZM7 11l2 2M10 8l2 2M13 5l2 2',
  // Two people, the second one shouldered behind the first — at dock size a
  // pair of equal heads reads as a blur, an offset pair reads as company.
  friends: 'M15 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M8.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 20v-1.5a4 4 0 0 0-3-3.87M16 3.7a4 4 0 0 1 0 7.5',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  swap: 'm16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16',

  // Activity categories. Deliberately simple single-stroke shapes — they sit
  // at 28px in the category grid, where detail turns to mud.
  heart: 'M12 20s-7-4.5-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.5-7 9-7 9Z',
  dumbbell: 'M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11',
  barbell: 'M2 12h20M5 7v10M19 7v10M8.5 9v6M15.5 9v6',
  stretch: 'M12 4.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM12 7v6M12 13l-3.5 8M12 13l3.5 8M6 9.5l6 1.5 6-1.5',
  // Seams only, no equator line — a circle crossed by a straight vertical and
  // horizontal reads as a crosshair, not a ball.
  ball: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M7.6 4.3c2.4 4.6 2.4 10.8 0 15.4M16.4 4.3c-2.4 4.6-2.4 10.8 0 15.4',
  mountain: 'm2 20 7-12 4.5 7.5L16 11l6 9H2Z',
  home: 'M3 10.5 12 3l9 7.5M5.5 9.2V21h13V9.2M10 21v-6h4v6',
  briefcase: 'M3 8.5h18V20H3zM8.5 8.5V5.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3M3 13h18',
}

const d = computed(() => paths[props.name] ?? paths.plus!)
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="d" />
  </svg>
</template>
