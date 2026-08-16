<script setup lang="ts">
import type { DiaryEntry, MealName } from '~/composables/useDiary'

const props = defineProps<{
  meal: MealName
  label: string
  entries: DiaryEntry[]
  date: string
}>()

defineEmits<{ remove: [id: number] }>()

const kcal = computed(() =>
  Math.round(props.entries.reduce((sum, e) => sum + (e.nutrients.kcal ?? 0), 0)),
)

/** "1.5 × container" when a named serving was used, otherwise "150 g". */
function portion(entry: DiaryEntry) {
  const unit = entry.food.is_liquid ? 'ml' : 'g'
  if (entry.serving_label && entry.serving_count) {
    const count = Number(entry.serving_count.toFixed(2))
    return `${count} × ${entry.serving_label} · ${Math.round(entry.grams)} ${unit}`
  }
  return `${Math.round(entry.grams)} ${unit}`
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
              :to="`/food/${entry.food.id}?entry=${entry.id}&d=${date}&meal=${meal}`"
              class="block truncate font-medium text-sm hover:underline"
            >
              {{ entry.food.name }}
            </NuxtLink>
            <div class="text-xs text-base-content/60 truncate">
              <span v-if="entry.food.brand">{{ entry.food.brand }} · </span>{{ portion(entry) }}
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

      <p v-else class="px-4 pb-1 text-sm text-base-content/40">Nothing logged yet.</p>

      <NuxtLink
        :to="`/add?meal=${meal}&d=${date}`"
        class="btn btn-ghost btn-sm justify-start gap-2 m-2 mt-1 text-primary"
      >
        <AppIcon name="plus" class="w-4 h-4" />
        Add food
      </NuxtLink>
    </div>
  </section>
</template>
