<script setup lang="ts">
import {
  DEFAULT_RATE_KG_PER_WEEK,
  MAX_SAFE_RATE_KG,
  activityLevel,
  calorieFloor,
  dailyDeltaToRate,
  daysToGoal,
  formatWeight,
  kgToLb,
  lbToKg,
  maintenanceCalories,
  planFromRate,
  ratePresets,
  type ActivityKey,
  type Sex,
  type WeightUnit,
} from '#shared/body'
import { addDays, fromLocalDate } from '~/utils/dates'

const props = defineProps<{
  open: boolean
  sex: Sex
  age: number
  heightCm: number
  weightKg: number
  activity: ActivityKey
  weightUnit: WeightUnit
  /** Current macro grams, so they can be rescaled alongside the target. */
  macros: { protein_g: number; carbs_g: number; fat_g: number }
  /** The calorie goal those macros were chosen against. */
  currentCalorieGoal: number
  /** The user's today, for projecting a goal date. Null until timezone known. */
  today: string | null
  /** Existing plan, so reopening the dialog resumes where it left off. */
  goalWeightKg: number | null
  goalRateKgPerWeek: number | null
}>()

const emit = defineEmits<{
  close: []
  apply: [plan: {
    calorie_goal: number
    goal_weight_kg: number | null
    goal_rate_kg_per_week: number
    macros?: { protein_g: number; carbs_g: number; fat_g: number }
  }]
}>()

type Direction = 'lose' | 'maintain' | 'gain'

const dialog = useTemplateRef<HTMLDialogElement>('dialog')

const direction = ref<Direction>('maintain')
/** Always positive; `direction` carries the sign. */
const magnitude = ref(DEFAULT_RATE_KG_PER_WEEK)
const goalWeight = ref<number | null>(null)
const rescaleMacros = ref(true)

const body = computed(() => ({
  sex: props.sex,
  age: props.age,
  weightKg: props.weightKg,
  heightCm: props.heightCm,
}))

const maintenance = computed(() =>
  Math.round(maintenanceCalories(body.value, props.activity)),
)

const rateKgPerWeek = computed(() => {
  if (direction.value === 'maintain') return 0
  return direction.value === 'lose' ? -magnitude.value : magnitude.value
})

const plan = computed(() => planFromRate(body.value, props.activity, rateKgPerWeek.value))

/** Targets are rounded to 10 kcal — the input's own step, and false precision below that. */
const targetCalories = computed(() => Math.round(plan.value.targetCalories / 10) * 10)

/**
 * Typing a calorie figure is the other way into the same plan: derive the rate
 * it implies and let the direction follow the sign. A ±25 kcal dead zone stops
 * "maintenance plus rounding" from reading as a deliberate gain.
 */
function setCalories(value: number) {
  if (!Number.isFinite(value)) return
  const delta = value - maintenance.value
  if (Math.abs(delta) < 25) {
    direction.value = 'maintain'
    return
  }
  direction.value = delta < 0 ? 'lose' : 'gain'
  magnitude.value = Math.abs(Number(dailyDeltaToRate(delta).toFixed(4)))
}

/** Rate shown in the user's own unit; stored in kg either way. */
const displayRate = computed({
  get: () =>
    Number(
      (props.weightUnit === 'lb' ? kgToLb(magnitude.value) : magnitude.value).toFixed(2),
    ),
  set: (value: number) => {
    if (!Number.isFinite(value) || value < 0) return
    magnitude.value = props.weightUnit === 'lb' ? lbToKg(value) : value
  },
})

const presets = computed(() => ratePresets(props.weightUnit))

function selectPreset(kgPerWeek: number) {
  magnitude.value = kgPerWeek
  if (direction.value === 'maintain') direction.value = 'lose'
}

const isPreset = (kgPerWeek: number) => Math.abs(magnitude.value - kgPerWeek) < 0.001

// --- Warnings -------------------------------------------------------------

const floor = computed(() => calorieFloor(props.sex))
const belowFloor = computed(() => targetCalories.value < floor.value)
const tooFast = computed(() => Math.abs(rateKgPerWeek.value) > MAX_SAFE_RATE_KG + 0.001)

/** Goal weight pointing the opposite way to the chosen rate is a mistake worth naming. */
const goalWeightKgValue = computed(() =>
  goalWeight.value === null
    ? null
    : props.weightUnit === 'lb'
      ? lbToKg(goalWeight.value)
      : goalWeight.value,
)

/**
 * A goal weight is a statement of intent, so the direction follows it. Typing
 * a number below your current weight and being left on "Maintain" — with a
 * warning telling you the two disagree — is the app arguing with you about
 * something it can just work out.
 */
watch(goalWeightKgValue, (goal) => {
  if (goal === null || !props.weightKg) return
  const delta = goal - props.weightKg
  // A goal within 100 g of today really is maintenance.
  if (Math.abs(delta) < 0.1) {
    direction.value = 'maintain'
    return
  }
  direction.value = delta < 0 ? 'lose' : 'gain'
  if (magnitude.value <= 0) magnitude.value = DEFAULT_RATE_KG_PER_WEEK
})

const goalMismatch = computed(() => {
  const goal = goalWeightKgValue.value
  if (goal === null || direction.value === 'maintain') return false
  const wantsLoss = direction.value === 'lose'
  return wantsLoss ? goal > props.weightKg : goal < props.weightKg
})

const projection = computed(() => {
  const goal = goalWeightKgValue.value
  if (goal === null || !props.today) return null
  const days = daysToGoal(props.weightKg, goal, rateKgPerWeek.value)
  if (days === null || days > 365 * 5) return null
  const date = addDays(props.today, days)
  return {
    days,
    label: fromLocalDate(date).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
  }
})

const activityName = computed(() => activityLevel(props.activity)?.label ?? 'Sedentary')

// --- Open / close ---------------------------------------------------------

watch(
  () => props.open,
  (open) => {
    if (!open) {
      dialog.value?.close()
      return
    }
    // Resume the stored plan, or start from maintenance.
    const rate = props.goalRateKgPerWeek ?? 0
    direction.value = rate === 0 ? 'maintain' : rate < 0 ? 'lose' : 'gain'
    magnitude.value = rate === 0 ? DEFAULT_RATE_KG_PER_WEEK : Math.abs(rate)
    goalWeight.value =
      props.goalWeightKg === null
        ? null
        : Number(
            (props.weightUnit === 'lb'
              ? kgToLb(props.goalWeightKg)
              : props.goalWeightKg
            ).toFixed(1),
          )
    dialog.value?.showModal()
  },
)

function apply() {
  // Scale so the macros *add up to* the new target, keeping their ratio.
  // Anchoring to what they currently sum to (rather than to the old calorie
  // goal) makes this idempotent: applying the same target twice is a no-op,
  // where scaling by goal-over-goal shrank them a little every time.
  const macroCalories =
    props.macros.protein_g * 4 + props.macros.carbs_g * 4 + props.macros.fat_g * 9
  const base = macroCalories > 0 ? macroCalories : props.currentCalorieGoal
  const scale = targetCalories.value / Math.max(base, 1)
  emit('apply', {
    calorie_goal: targetCalories.value,
    goal_weight_kg:
      goalWeightKgValue.value === null
        ? null
        : Number(goalWeightKgValue.value.toFixed(2)),
    goal_rate_kg_per_week: Number(rateKgPerWeek.value.toFixed(4)),
    // Rescaling keeps the split the user already chose and moves it onto the
    // new total, rather than imposing some default ratio on them.
    macros: rescaleMacros.value
      ? {
          protein_g: Math.round(props.macros.protein_g * scale),
          carbs_g: Math.round(props.macros.carbs_g * scale),
          fat_g: Math.round(props.macros.fat_g * scale),
        }
      : undefined,
  })
}
</script>

<template>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle" @close="emit('close')">
    <div class="modal-box flex flex-col gap-3">
      <h3 class="font-semibold text-lg">Calorie target</h3>

      <!-- Maintenance ------------------------------------------------------>
      <div class="rounded-box bg-base-200 p-3 flex items-center justify-between">
        <div>
          <div class="text-xs text-base-content/60">Maintain weight</div>
          <div class="text-xs text-base-content/50">
            {{ activityName }} · {{ formatWeight(weightKg, weightUnit) }}
          </div>
        </div>
        <div class="text-2xl font-semibold tabular">
          {{ maintenance }} <span class="text-sm font-normal text-base-content/50">kcal</span>
        </div>
      </div>

      <!-- Direction -------------------------------------------------------->
      <div role="tablist" class="tabs tabs-box">
        <button
          v-for="d in (['lose', 'maintain', 'gain'] as Direction[])"
          :key="d"
          role="tab" class="tab flex-1 capitalize"
          :class="{ 'tab-active': direction === d }"
          @click="direction = d"
        >{{ d }}</button>
      </div>

      <template v-if="direction !== 'maintain'">
        <div class="flex flex-col gap-2">
          <span class="label-text text-xs">
            {{ direction === 'lose' ? 'Lose' : 'Gain' }} per week
          </span>
          <div class="flex gap-1 flex-wrap">
            <button
              v-for="p in presets"
              :key="p.label"
              class="btn btn-xs flex-1"
              :class="isPreset(p.kgPerWeek) ? 'btn-primary' : 'btn-outline'"
              @click="selectPreset(p.kgPerWeek)"
            >{{ p.label }}</button>
          </div>
          <label class="join w-full">
            <span class="sr-only">Custom weekly rate</span>
            <input
              v-model.number="displayRate"
              type="number" min="0" max="2" step="0.05" inputmode="decimal"
              class="input input-bordered input-sm join-item flex-1"
            >
            <span class="btn btn-sm join-item no-animation pointer-events-none">
              {{ weightUnit }} / week
            </span>
          </label>
        </div>
      </template>

      <!-- Target ----------------------------------------------------------->
      <label class="form-control">
        <span class="label-text text-xs mb-1">Daily calorie target</span>
        <div class="join w-full">
          <input
            :value="targetCalories"
            type="number" min="500" max="20000" step="10" inputmode="numeric"
            class="input input-bordered join-item flex-1 text-lg font-semibold tabular"
            @change="setCalories(Number(($event.target as HTMLInputElement).value))"
          >
          <span class="btn join-item no-animation pointer-events-none">kcal</span>
        </div>
      </label>

      <p class="text-xs text-base-content/60">
        <template v-if="direction === 'maintain'">
          Eating your maintenance calories should hold your weight steady.
        </template>
        <template v-else>
          {{ Math.abs(Math.round(plan.dailyDelta)) }} kcal
          {{ plan.dailyDelta < 0 ? 'below' : 'above' }} maintenance.
        </template>
      </p>

      <!-- Goal weight ------------------------------------------------------>
      <label class="form-control">
        <span class="label-text text-xs mb-1">Goal weight (optional)</span>
        <div class="join w-full">
          <input
            v-model.number="goalWeight"
            type="number" min="10" step="any" inputmode="decimal"
            class="input input-bordered input-sm join-item flex-1"
            :placeholder="weightUnit"
          >
          <span class="btn btn-sm join-item no-animation pointer-events-none">
            {{ weightUnit }}
          </span>
        </div>
      </label>

      <p v-if="projection" class="text-xs text-base-content/60">
        At this rate you'd reach it around <strong>{{ projection.label }}</strong>
        ({{ projection.days }} days).
      </p>
      <p v-else-if="goalMismatch" class="text-xs text-warning">
        Your goal weight is
        {{ direction === 'lose' ? 'above' : 'below' }} your current weight, but
        you've chosen to {{ direction }}.
      </p>

      <!-- Warnings --------------------------------------------------------->
      <div v-if="belowFloor" class="alert alert-warning text-xs py-2">
        <span>
          {{ targetCalories }} kcal is below the {{ floor }} kcal a day that's
          generally considered the lowest you can eat and still cover your
          vitamins and minerals from food. Consider a slower rate.
        </span>
      </div>
      <div v-if="tooFast" class="alert alert-warning text-xs py-2">
        <span>
          Changing weight faster than
          {{ weightUnit === 'lb' ? '2 lb' : '1 kg' }} a week is hard to sustain
          and costs more muscle than a slower approach.
        </span>
      </div>

      <label class="label cursor-pointer justify-start gap-3 py-0">
        <input v-model="rescaleMacros" type="checkbox" class="checkbox checkbox-sm">
        <span class="label-text text-xs">
          Scale my protein, carb and fat targets to match
        </span>
      </label>

      <p class="text-[0.65rem] text-base-content/40 leading-snug">
        Estimated with the Mifflin-St Jeor equation.
        <template v-if="sex === 'unspecified'">
          With no sex recorded this uses the midpoint of the male and female
          formulas, so it's rougher than usual.
        </template>
        Real metabolisms vary by around 10% either way — treat this as a
        starting point and adjust once you see how your weight actually moves.
      </p>

      <div class="modal-action mt-1">
        <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" @click="apply">Use this target</button>
      </div>
    </div>

    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
</template>
