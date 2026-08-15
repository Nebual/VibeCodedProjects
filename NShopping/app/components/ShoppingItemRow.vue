<script setup lang="ts">
import type { Item } from '#shared/types'
import { TAG_COLOR_LABELS, TAG_SYMBOL_LABELS } from '#shared/tags'

const props = defineProps<{
  item: Item
  now: number
  readOnly?: boolean
  /** In selection mode the checkbox picks the row out for tagging instead of buying it. */
  selectable?: boolean
  selected?: boolean
}>()
const emit = defineEmits<{ toggle: [], remove: [], select: [] }>()

/** Empty for something ticked off inside the correction window — it was never really bought. */
const meta = computed(() => {
  const { bought, boughtAt, addedAt } = props.item
  if (!bought) return `added ${relativeTime(addedAt, props.now)}`
  return boughtAt ? `bought ${relativeTime(boughtAt, props.now)}` : ''
})

/**
 * One checkbox, two jobs. Reusing it rather than adding a second one keeps the row the
 * same shape in both modes, so entering selection doesn't reflow the whole list under
 * the finger that just opened it.
 */
const checked = computed(() => (props.selectable ? Boolean(props.selected) : props.item.bought))

/**
 * Colour is what the list is organised by, but on a row it is carried entirely by a tint
 * and a stripe, and the symbol renders as an `aria-hidden` glyph. Spelling both out keeps
 * the grouping available to a screen reader — and to anyone for whom a 12% tint doesn't
 * separate seven hues, which is roughly the point of the tint being that soft.
 */
const tagLabel = computed(() => [
  props.item.color ? TAG_COLOR_LABELS[props.item.color] : null,
  props.item.symbol ? TAG_SYMBOL_LABELS[props.item.symbol] : null,
].filter(Boolean).join(', '))

const checkboxLabel = computed(() => (props.selectable
  ? `Select ${props.item.name}`
  : `Mark ${props.item.name} as ${props.item.bought ? 'still needed' : 'bought'}`))
</script>

<template>
  <li
    class="flex items-center gap-2.5 rounded-box border px-2.5 py-1.5 transition-opacity"
    :class="[
      item.color ? `tag-${item.color} tag-row` : 'border-base-300 bg-base-100',
      item.bought ? 'opacity-50' : '',
      selected ? 'ring-2 ring-primary ring-offset-1 ring-offset-base-200' : '',
    ]"
  >
    <label class="flex min-w-0 flex-1 items-center gap-2.5" :class="readOnly ? '' : 'cursor-pointer'">
      <input
        type="checkbox"
        class="checkbox checkbox-sm shrink-0"
        :class="selectable ? 'checkbox-secondary' : 'checkbox-primary'"
        :checked="checked"
        :disabled="readOnly"
        :aria-label="checkboxLabel"
        @change="selectable ? emit('select') : emit('toggle')"
      >
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 truncate text-sm font-medium" :class="item.bought ? 'line-through' : ''">{{ item.name }}</span>
          <!-- Trailing, so names still line up down the page whether or not they carry one. -->
          <TagSymbolIcon
            v-if="item.symbol"
            :symbol="item.symbol"
            class="size-3.5 shrink-0 opacity-70"
            :class="item.color ? 'tag-ink' : ''"
          />
          <span v-if="tagLabel" class="sr-only">({{ tagLabel }})</span>
        </span>
        <span v-if="meta" class="block text-[0.6rem] leading-tight text-base-content/35">{{ meta }}</span>
      </span>
    </label>

    <!-- Deliberately only offered once an item is bought, so the list can't be gutted by
         accident — and never mid-selection, where a stray tap should only ever select. -->
    <div v-if="item.bought && !readOnly && !selectable" class="dropdown dropdown-end shrink-0">
      <div tabindex="0" role="button" class="btn btn-ghost btn-xs btn-circle" :aria-label="`Options for ${item.name}`">
        <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
        </svg>
      </div>
      <ul tabindex="0" class="dropdown-content menu z-20 w-40 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
        <li>
          <button type="button" class="text-error" @click="emit('remove')">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Delete
          </button>
        </li>
      </ul>
    </div>
  </li>
</template>
