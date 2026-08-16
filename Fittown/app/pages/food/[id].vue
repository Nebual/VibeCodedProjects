<script setup lang="ts">
import { scaleNutrients } from '#shared/nutrients'
import {
  baseUnit,
  defaultAmount,
  defaultUnitKey,
  portionUnits,
  roundGrams,
} from '#shared/portions'
import type { FoodRow, Goals, MealName } from '~/composables/useDiary'
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

const isLiquid = computed(() => !!food.value?.is_liquid)
const unit = computed(() => baseUnit(isLiquid.value))

// The unit preference only decides which option is selected first — every
// option stays available, because a recipe mixes units freely.
const { data: settings } = await useFetch<{ goals: Goals }>('/api/goals')
const system = computed(() => settings.value?.goals?.food_system ?? 'metric')

interface PortionOption {
  key: string
  label: string
  /** Base units (g or ml) per one of these. */
  size: number
  /** 'base' portions are logged as a plain weight, with no "2 × oz" label. */
  kind: 'serving' | 'unit' | 'base'
}

/**
 * Portion options: the product's own serving, any named servings, then the
 * generic units. Each carries its size so the picker can show what a portion
 * works out to before you commit to it.
 */
const options = computed<PortionOption[]>(() => {
  const list: PortionOption[] = []
  const f = food.value
  if (!f) return list

  if (f.serving_grams) {
    list.push({
      key: 'serving',
      label: f.serving_size_text?.trim() || 'serving',
      size: f.serving_grams,
      kind: 'serving',
    })
  }
  for (const s of data.value?.servings ?? []) {
    list.push({ key: `s${s.id}`, label: s.label, size: s.grams, kind: 'serving' })
  }
  for (const u of portionUnits(isLiquid.value)) {
    list.push({
      key: `u:${u.key}`,
      label: u.label,
      size: u.size,
      kind: u.size === 1 ? 'base' : 'unit',
    })
  }
  return list
})

/**
 * Does this label already state a size? Open Food Facts serving text usually
 * does — "5.3 ONZ (150 g)" — and appending our own would give "(150 g) (150 g)".
 */
const STATES_SIZE = /\d\s*(g|ml|kg|l)\b/i

/** "oz (28 g)" — the equivalence belongs in the option, not just after it. */
function optionLabel(o: PortionOption) {
  if (o.size === 1 || STATES_SIZE.test(o.label)) return o.label
  return `${o.label} (${roundGrams(o.size)} ${unit.value})`
}

const selectedKey = ref<string>('')
const amount = ref(1)

// Default to the product's stated serving, else the user's preferred unit.
watchEffect(() => {
  if (!food.value || selectedKey.value) return
  const stated = options.value.find((o) => o.kind === 'serving')
  if (stated) {
    selectedKey.value = stated.key
    amount.value = 1
    return
  }
  const preferred = `u:${defaultUnitKey(system.value, isLiquid.value)}`
  const fallback = options.value[0]
  const option = options.value.find((o) => o.key === preferred) ?? fallback
  if (!option) return
  selectedKey.value = option.key
  amount.value = defaultAmount(option)
})

const selected = computed(() => options.value.find((o) => o.key === selectedKey.value))

const grams = computed(() => (selected.value ? amount.value * selected.value.size : 0))

/**
 * Shown whenever the chosen unit isn't already grams/millilitres. Suppressed
 * for a single serving whose label states its own size, where the line would
 * just be "1 × 5.3 ONZ (150 g) = 150 g".
 */
const conversion = computed(() => {
  const opt = selected.value
  if (!opt || opt.kind === 'base' || !amount.value) return null
  if (amount.value === 1 && STATES_SIZE.test(opt.label)) return null
  return `${amount.value} × ${opt.label} = ${roundGrams(grams.value)} ${unit.value}`
})

const preview = computed(() =>
  food.value ? scaleNutrients(food.value as Record<string, unknown>, grams.value) : {},
)

function onPortionChange() {
  // Switching between "1 serving", "100 g" and "4 oz" needs a sane starting
  // amount — leaving `1` behind after a switch to grams is a 1 g portion.
  if (selected.value) amount.value = defaultAmount(selected.value)
}

const saving = ref(false)
const saveError = ref<string | null>(null)

async function save() {
  if (!food.value || grams.value <= 0) return
  saving.value = true
  saveError.value = null

  // Grams are what gets stored; the label and count ride along only so the
  // diary can redisplay "4 × oz" instead of "113 g".
  const opt = selected.value
  const named = opt && opt.kind !== 'base'
  const body = {
    grams: grams.value,
    serving_label: named ? opt!.label : null,
    serving_count: named ? amount.value : null,
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
                {{ optionLabel(o) }}
              </option>
            </select>
          </label>
        </div>

        <p v-if="conversion" class="text-xs text-base-content/60 tabular -mt-1">
          {{ conversion }}
        </p>

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
          Logging {{ roundGrams(grams) }} {{ unit }}
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
