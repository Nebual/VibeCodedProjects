<script setup lang="ts">
import { roundGrams } from '#shared/portions'
import type { FoodRow } from '~/composables/useDiary'

/**
 * Pick a food without leaving the screen you're on.
 *
 * The recipe editor sends you out to `/add` and back, which is right there: the
 * recipe is saved, so a round trip costs nothing. Here it would cost the
 * adjustments in progress — you came to say "three eggs and a bit more cheddar",
 * and navigating away to find the cheddar would drop the eggs.
 *
 * Deliberately thinner than `/add`: no scanner, no Frequent, no recipes. This is
 * for one small addition or correction to a meal, and the full picker is one tap
 * away on the recipe itself.
 */
const props = defineProps<{
  open: boolean
  /** Shown as the heading — "Add to this meal" reads differently to "Swap X". */
  title: string
}>()

const emit = defineEmits<{ close: []; picked: [food: FoodRow, grams: number] }>()

const query = ref('')
const debounced = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

watch(query, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => (debounced.value = value.trim()), 250)
})

// Cleared on open rather than on close, so the list doesn't visibly empty out
// while the dialog is fading away.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    debounced.value = ''
  },
)

const { data, status } = await useFetch<{ results: FoodRow[] }>('/api/foods/search', {
  query: { q: debounced },
  default: () => ({ results: [] }),
  immediate: false,
  // Only ask once there is something to ask about; the API wants two characters.
  watch: [debounced],
})

const results = computed(() => (debounced.value.length < 2 ? [] : data.value.results))

/**
 * What amount to start from.
 *
 * The food's own serving where it has one, otherwise 100 g — the same fallback
 * the portion picker uses, and a figure that is obviously a starting point
 * rather than a measurement. The row it lands in is editable, so this only has
 * to be sensible, not right.
 */
function pick(food: FoodRow) {
  emit('picked', food, roundGrams(food.serving_grams || 100))
  emit('close')
}
</script>

<template>
  <dialog class="modal modal-bottom sm:modal-middle" :class="{ 'modal-open': open }">
    <div class="modal-box p-4 gap-3 flex flex-col max-h-[80vh]">
      <h3 class="font-semibold">{{ title }}</h3>

      <label class="form-control">
        <input
          v-model="query"
          type="search"
          class="input input-bordered w-full"
          placeholder="Search foods"
          autocomplete="off"
        >
      </label>

      <ul v-if="results.length" class="flex flex-col divide-y divide-base-200 overflow-y-auto -mx-4">
        <li v-for="food in results" :key="food.id">
          <button
            class="w-full text-left px-4 py-2.5 hover:bg-base-200 transition-colors"
            @click="pick(food)"
          >
            <div class="font-medium text-sm truncate">{{ food.name }}</div>
            <div class="text-xs text-base-content/60 truncate tabular">
              <span v-if="food.brand">{{ food.brand }} · </span>
              <template v-if="food.kcal !== null">{{ Math.round(food.kcal) }} kcal / 100 g</template>
              <template v-else>energy not recorded</template>
            </div>
          </button>
        </li>
      </ul>

      <p
        v-else-if="debounced.length >= 2 && status !== 'pending'"
        class="text-sm text-base-content/50 py-2"
      >
        Nothing found for “{{ debounced }}”.
      </p>
      <p v-else class="text-sm text-base-content/50 py-2">
        Type at least two letters.
      </p>

      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
      </div>
    </div>

    <!-- Tapping the backdrop closes it, which on a phone is the gesture people
         reach for before they look for a button. -->
    <form method="dialog" class="modal-backdrop" @click="emit('close')">
      <button>close</button>
    </form>
  </dialog>
</template>
