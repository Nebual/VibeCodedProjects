<script setup lang="ts">
import { showsGramPortions } from '#shared/recipes'
import type { DiaryEntry, MealName } from '~/composables/useDiary'

const props = defineProps<{
  meal: MealName
  label: string
  entries: DiaryEntry[]
  date: string
}>()

defineEmits<{ remove: [id: number]; 'quick-add': [] }>()

const showQuickAdd = ref(false)

const kcal = computed(() =>
  Math.round(props.entries.reduce((sum, e) => sum + (e.nutrients.kcal ?? 0), 0)),
)

/**
 * "1.5 × container" when a named serving was used, otherwise "150 g".
 *
 * A recipe with no stated yield never shows grams: the weight behind the entry
 * is the raw ingredient sum, and printing it next to a cooked dish would quote
 * a weight nobody measured. "1 × serving" is the whole truth there.
 */
function portion(entry: DiaryEntry) {
  const unit = entry.food.is_liquid ? 'ml' : 'g'
  const weighed = showsGramPortions(entry.food)
  if (entry.serving_label && entry.serving_count) {
    const count = Number(entry.serving_count.toFixed(2))
    const label = `${count} × ${entry.serving_label}`
    return weighed ? `${label} · ${Math.round(entry.grams)} ${unit}` : label
  }
  return weighed ? `${Math.round(entry.grams)} ${unit}` : 'serving'
}

/**
 * Re-opening an entry lands on the portion it was logged with, rather than
 * resetting to a default the user never chose.
 */
function editLink(entry: DiaryEntry) {
  const params = new URLSearchParams({
    entry: String(entry.id),
    d: props.date,
    meal: props.meal,
    g: String(entry.grams),
  })
  if (entry.serving_label) params.set('sl', entry.serving_label)
  if (entry.serving_count) params.set('sc', String(entry.serving_count))
  return `/food/${entry.food.id}?${params}`
}
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-0">
      <header class="flex items-center justify-between px-4 pt-3 pb-2">
        <h2 class="font-semibold">{{ label }}</h2>
        <span class="text-sm text-base-content/60 tabular">{{ kcal }} kcal</span>
      </header>

      <ul v-if="entries.length" class="divide-y divide-base-200">
        <li
          v-for="entry in entries"
          :key="entry.id"
          class="flex items-center gap-3 px-4 py-2.5"
        >
          <div class="flex-1 min-w-0">
            <NuxtLink
              :to="editLink(entry)"
              class="block truncate font-medium text-sm hover:underline"
            >
              {{ entry.food.name }}
            </NuxtLink>
            <div class="text-xs text-base-content/60 truncate">
              <span v-if="entry.food.brand">{{ entry.food.brand }} · </span>{{ portion(entry) }}
            </div>
            <!-- What was different about this one: "3 × egg instead of 4 · no
                 bacon". Only ever set on a meal logged from a recipe with
                 changes, so it costs nothing on every other row. -->
            <div
              v-if="entry.food.recipe_log_note"
              class="text-xs text-base-content/50 truncate italic"
            >
              {{ entry.food.recipe_log_note }}
            </div>
          </div>

          <div class="text-right shrink-0">
            <div class="text-sm tabular">{{ Math.round(entry.nutrients.kcal ?? 0) }}</div>
            <div class="text-[0.65rem] text-base-content/50 tabular">
              P{{ Math.round(entry.nutrients.protein_g ?? 0) }}
              C{{ Math.round(entry.nutrients.carbs_g ?? 0) }}
              F{{ Math.round(entry.nutrients.fat_g ?? 0) }}
            </div>
          </div>

          <button
            class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
            :aria-label="`Remove ${entry.food.name}`"
            @click="$emit('remove', entry.id)"
          >
            <AppIcon name="trash" class="w-4 h-4" />
          </button>
        </li>
      </ul>

      <!--
        No "nothing logged yet" placeholder: four empty meals is the normal
        state of a morning, and saying so four times pushes the rest of the day
        off the screen. The "Add food" button already says the section is empty.
      -->

      <div class="flex items-center gap-1 m-2 mt-1">
        <NuxtLink
          :to="`/add?meal=${meal}&d=${date}`"
          class="btn btn-ghost btn-sm justify-start gap-2 text-primary flex-1"
        >
          <AppIcon name="plus" class="w-4 h-4" />
          Add food
        </NuxtLink>
        <button
          class="btn btn-ghost btn-xs text-base-content/60 shrink-0"
          @click="showQuickAdd = true"
        >
          Quick add
        </button>
      </div>
    </div>

    <QuickAddDialog
      :open="showQuickAdd"
      :meal="meal"
      :date="date"
      @close="showQuickAdd = false"
      @saved="showQuickAdd = false; $emit('quick-add')"
    />
  </section>
</template>
