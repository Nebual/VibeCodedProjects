<script setup lang="ts">
import type { Goals } from '~/composables/useDiary'

useHead({ title: 'Settings · Fittown' })

const { user, clear } = useUserSession()
const { data, refresh } = await useFetch<{ goals: Goals }>('/api/goals')

const form = reactive<Partial<Goals>>({})
watchEffect(() => {
  if (data.value?.goals) Object.assign(form, data.value.goals)
})

const saved = ref(false)
const saving = ref(false)

/**
 * Macro grams imply a calorie total. Showing the gap lets people notice that
 * their macro split doesn't add up to the goal they set.
 */
const macroCalories = computed(() =>
  Math.round((form.protein_g ?? 0) * 4 + (form.carbs_g ?? 0) * 4 + (form.fat_g ?? 0) * 9),
)
const macroGap = computed(() => macroCalories.value - (form.calorie_goal ?? 0))

async function save() {
  saving.value = true
  saved.value = false
  try {
    await $fetch('/api/goals', { method: 'PUT', body: { ...form } })
    await refresh()
    saved.value = true
    setTimeout(() => (saved.value = false), 2500)
  } finally {
    saving.value = false
  }
}

// Weight logging lives here since it feeds the exercise calorie estimate.
const today = useToday()
const weight = ref<number | null>(null)
const weightSaved = ref(false)
async function saveWeight() {
  if (!weight.value || !today.value) return
  await $fetch('/api/weight', {
    method: 'POST',
    body: { date: today.value, weight_kg: weight.value },
  })
  weightSaved.value = true
  setTimeout(() => (weightSaved.value = false), 2500)
}

async function signOut() {
  await $fetch('/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}

const goalFields = [
  { key: 'calorie_goal', label: 'Daily calories', unit: 'kcal', step: 10 },
  { key: 'protein_g', label: 'Protein', unit: 'g', step: 1 },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', step: 1 },
  { key: 'fat_g', label: 'Fat', unit: 'g', step: 1 },
  { key: 'fiber_g', label: 'Fibre', unit: 'g', step: 1 },
  { key: 'water_goal_ml', label: 'Water', unit: 'ml', step: 50 },
] as const
</script>

<template>
  <div class="flex flex-col gap-3">
    <h1 class="font-semibold text-lg px-1">Settings</h1>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Daily goals</h2>

        <div class="grid grid-cols-2 gap-2">
          <label v-for="f in goalFields" :key="f.key" class="form-control">
            <span class="label-text text-xs mb-1">{{ f.label }} ({{ f.unit }})</span>
            <input
              v-model.number="form[f.key]"
              type="number" min="0" :step="f.step" inputmode="numeric"
              class="input input-bordered input-sm w-full"
            >
          </label>
        </div>

        <p
          class="text-xs"
          :class="Math.abs(macroGap) > 50 ? 'text-warning' : 'text-base-content/50'"
        >
          Your macros add up to {{ macroCalories }} kcal
          <template v-if="Math.abs(macroGap) > 50">
            — {{ Math.abs(macroGap) }} kcal {{ macroGap > 0 ? 'above' : 'below' }} your calorie goal.
          </template>
        </p>

        <label class="label cursor-pointer justify-start gap-3">
          <input
            v-model="form.exercise_adds_calories"
            type="checkbox" class="toggle toggle-sm"
            :true-value="1" :false-value="0"
          >
          <span class="label-text">Add exercise calories to my daily budget</span>
        </label>
      </div>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Units</h2>
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control">
            <span class="label-text text-xs mb-1">Weight</span>
            <select v-model="form.weight_unit" class="select select-bordered select-sm w-full">
              <option value="kg">Kilograms</option>
              <option value="lb">Pounds</option>
            </select>
          </label>
          <label class="form-control">
            <span class="label-text text-xs mb-1">Volume</span>
            <select v-model="form.volume_unit" class="select select-bordered select-sm w-full">
              <option value="ml">Millilitres</option>
              <option value="floz">Fluid ounces</option>
            </select>
          </label>
        </div>
      </div>
    </section>

    <button class="btn btn-primary gap-2" :disabled="saving" @click="save">
      <span v-if="saving" class="loading loading-spinner loading-sm" />
      <AppIcon v-else-if="saved" name="check" class="w-4 h-4" />
      {{ saved ? 'Saved' : 'Save goals' }}
    </button>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <h2 class="font-semibold">Today's weight</h2>
        <p class="text-xs text-base-content/50">
          Used to estimate calories burned during exercise.
        </p>
        <div class="join">
          <input
            v-model.number="weight"
            type="number" min="10" step="any" inputmode="decimal"
            class="input input-bordered join-item flex-1" placeholder="kg"
          >
          <button class="btn join-item" :disabled="!weight || !today" @click="saveWeight">
            <AppIcon v-if="weightSaved" name="check" class="w-4 h-4" />
            <span v-else>Log</span>
          </button>
        </div>
      </div>
    </section>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-2">
        <h2 class="font-semibold">Account</h2>
        <p class="text-sm text-base-content/60">{{ user?.email }}</p>
        <button class="btn btn-outline btn-sm mt-1" @click="signOut">Sign out</button>
      </div>
    </section>
  </div>
</template>
