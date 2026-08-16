<script setup lang="ts">
import { scaleNutrients } from '#shared/nutrients'
import type { FoodRow, MealName } from '~/composables/useDiary'
import { MEAL_LABELS, MEAL_ORDER } from '~/composables/useDiary'

const route = useRoute()
const router = useRouter()

const foodId = computed(() => Number(route.params.id))
const today = useToday()
const date = computed(() => (route.query.d as string) || today.value)
/** Present when editing an existing diary row rather than adding a new one. */
const entryId = computed(() => (route.query.entry ? Number(route.query.entry) : null))

const meal = ref<MealName>((route.query.meal as MealName) || 'snack')

interface Serving { id: number; label: string; grams: number }
const { data, error } = await useFetch<{ food: FoodRow; servings: Serving[] }>(
  () => `/api/foods/${foodId.value}`,
)

const food = computed(() => data.value?.food)
useHead({ title: () => `${food.value?.name ?? 'Food'} · Fittown` })

const unit = computed(() => (food.value?.is_liquid ? 'ml' : 'g'))

/**
 * Portion options: the product's own serving, any named servings, and a
 * plain weight. Value is grams-per-unit; `null` means "type grams directly".
 */
const options = computed(() => {
  const list: { key: string; label: string; grams: number | null }[] = []
  const f = food.value
  if (!f) return list

  if (f.serving_grams) {
    list.push({
      key: 'serving',
      label: f.serving_size_text?.trim() || 'serving',
      grams: f.serving_grams,
    })
  }
  for (const s of data.value?.servings ?? []) {
    list.push({ key: `s${s.id}`, label: s.label, grams: s.grams })
  }
  list.push({ key: 'grams', label: unit.value, grams: null })
  return list
})

const selectedKey = ref<string>('')
const amount = ref(1)

// Default to the product's stated serving; fall back to 100 g.
watchEffect(() => {
  if (!food.value || selectedKey.value) return
  const first = options.value[0]
  if (!first) return
  selectedKey.value = first.key
  amount.value = first.grams ? 1 : 100
})

const selected = computed(() => options.value.find((o) => o.key === selectedKey.value))

const grams = computed(() => {
  const opt = selected.value
  if (!opt) return 0
  return opt.grams === null ? amount.value : amount.value * opt.grams
})

const preview = computed(() =>
  food.value ? scaleNutrients(food.value as Record<string, unknown>, grams.value) : {},
)

function onPortionChange() {
  // Switching between "1 serving" and "100 g" needs a sane starting amount.
  amount.value = selected.value?.grams === null ? 100 : 1
}

const saving = ref(false)
const saveError = ref<string | null>(null)

async function save() {
  if (!food.value || grams.value <= 0) return
  saving.value = true
  saveError.value = null

  const opt = selected.value
  const body = {
    grams: grams.value,
    serving_label: opt && opt.grams !== null ? opt.label : null,
    serving_count: opt && opt.grams !== null ? amount.value : null,
  }

  try {
    if (entryId.value) {
      await $fetch(`/api/diary/entries/${entryId.value}`, {
        method: 'PATCH',
        body: { ...body, meal: meal.value },
      })
    } else {
      await $fetch('/api/diary/entries', {
        method: 'POST',
        body: { date: date.value, meal: meal.value, food_id: food.value.id, ...body },
      })
    }
    await router.push(date.value ? `/?d=${date.value}` : '/')
  } catch (err) {
    saveError.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not save'
    saving.value = false
  }
}

async function remove() {
  if (!entryId.value) return
  saving.value = true
  await $fetch(`/api/diary/entries/${entryId.value}`, { method: 'DELETE' })
  await router.push(date.value ? `/?d=${date.value}` : '/')
}
</script>

<template>
  <div v-if="error" class="alert alert-error">
    <span>Food not found.</span>
  </div>

  <div v-else-if="food" class="flex flex-col gap-3">
    <header class="flex items-start gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <div class="flex-1 min-w-0 pt-1">
        <h1 class="font-semibold leading-tight">{{ food.name }}</h1>
        <p v-if="food.brand" class="text-sm text-base-content/60 truncate">{{ food.brand }}</p>
      </div>
    </header>

    <!-- Portion -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex gap-2">
          <label class="form-control flex-1">
            <span class="label-text text-xs mb-1">Amount</span>
            <input
              v-model.number="amount"
              type="number"
              min="0"
              step="any"
              inputmode="decimal"
              class="input input-bordered w-full"
            >
          </label>

          <label class="form-control flex-1">
            <span class="label-text text-xs mb-1">Portion</span>
            <select
              v-model="selectedKey"
              class="select select-bordered w-full"
              @change="onPortionChange"
            >
              <option v-for="o in options" :key="o.key" :value="o.key">
                {{ o.label }}
              </option>
            </select>
          </label>
        </div>

        <label class="form-control">
          <span class="label-text text-xs mb-1">Meal</span>
          <div role="tablist" class="tabs tabs-box">
            <button
              v-for="m in MEAL_ORDER"
              :key="m"
              role="tab"
              class="tab flex-1 text-xs"
              :class="{ 'tab-active': meal === m }"
              @click="meal = m"
            >
              {{ MEAL_LABELS[m] }}
            </button>
          </div>
        </label>

        <p class="text-xs text-base-content/50 tabular">
          Logging {{ Math.round(grams) }} {{ unit }}
        </p>
      </div>
    </section>

    <!-- What that portion contains -->
    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex items-baseline justify-between">
          <h2 class="font-semibold">In this portion</h2>
          <span class="text-2xl font-semibold tabular">
            {{ Math.round(preview.kcal ?? 0) }}
            <span class="text-sm font-normal text-base-content/60">kcal</span>
          </span>
        </div>
        <NutrientBreakdown :totals="preview" />
      </div>
    </section>

    <div v-if="saveError" class="alert alert-error text-sm">{{ saveError }}</div>

    <div class="flex gap-2">
      <button
        v-if="entryId"
        class="btn btn-outline btn-error"
        :disabled="saving"
        @click="remove"
      >
        <AppIcon name="trash" class="w-4 h-4" />
      </button>
      <button
        class="btn btn-primary flex-1 gap-2"
        :disabled="saving || grams <= 0"
        @click="save"
      >
        <span v-if="saving" class="loading loading-spinner loading-sm" />
        {{ entryId ? 'Save changes' : `Add to ${MEAL_LABELS[meal]}` }}
      </button>
    </div>
  </div>
</template>
