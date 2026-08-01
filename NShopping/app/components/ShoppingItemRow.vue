<script setup lang="ts">
import type { Item } from '#shared/types'

const props = defineProps<{ item: Item, now: number, readOnly?: boolean }>()
const emit = defineEmits<{ toggle: [], remove: [] }>()

/** Empty for something ticked off inside the correction window — it was never really bought. */
const meta = computed(() => {
  const { bought, boughtAt, addedAt } = props.item
  if (!bought) return `added ${relativeTime(addedAt, props.now)}`
  return boughtAt ? `bought ${relativeTime(boughtAt, props.now)}` : ''
})
</script>

<template>
  <li
    class="flex items-center gap-2.5 rounded-box border border-base-300 bg-base-100 px-2.5 py-1.5 transition-opacity"
    :class="item.bought ? 'opacity-50' : ''"
  >
    <label class="flex min-w-0 flex-1 items-center gap-2.5" :class="readOnly ? '' : 'cursor-pointer'">
      <input
        type="checkbox"
        class="checkbox checkbox-sm checkbox-primary shrink-0"
        :checked="item.bought"
        :disabled="readOnly"
        :aria-label="`Mark ${item.name} as ${item.bought ? 'still needed' : 'bought'}`"
        @change="emit('toggle')"
      >
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium" :class="item.bought ? 'line-through' : ''">{{ item.name }}</span>
        <span v-if="meta" class="block text-[0.6rem] leading-tight text-base-content/35">{{ meta }}</span>
      </span>
    </label>

    <!-- Deliberately only offered once an item is bought, so the list can't be gutted by accident. -->
    <div v-if="item.bought && !readOnly" class="dropdown dropdown-end shrink-0">
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
