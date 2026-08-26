<script setup lang="ts">
import {
  WEEKDAY_LABELS,
  dayOfMonthOf,
  weekdayOf,
  type ReminderScheduleRule,
} from '#shared/reminders'
import type { ReminderRow } from '~/composables/useDiary'

const props = defineProps<{
  reminders: ReminderRow[]
  date: string
}>()

const emit = defineEmits<{
  add: [name: string, schedule: NewSchedule]
  toggle: [id: number, done: boolean]
  updateSchedule: [id: number, schedule: NewSchedule]
  skipToday: [id: number]
  remove: [id: number]
}>()

export interface NewSchedule {
  freq: 'daily' | 'weekly' | 'monthly'
  interval?: number
  byweekday?: number[]
  day_of_month?: number
}

const adding = ref(false)
const newName = ref('')

function add() {
  const name = newName.value.trim()
  if (!name) return
  emit('add', name, defaultSchedule())
  newName.value = ''
  adding.value = false
}

/** Which row's gear menu is open (one at a time). */
const openMenu = ref<number | null>(null)
/** Which row's recurrence modal is open. */
const editing = ref<ReminderRow | null>(null)

/** Two taps to delete-from-this-day-onward; past days keep their history. */
const confirmingRemove = ref<number | null>(null)

function askRemove(id: number) {
  // Stay inside the open dropdown — the Yes/No confirm replaces this item's
  // row in place, so closing the menu would hide the question.
  confirmingRemove.value = id
}

function confirmRemove(id: number) {
  emit('remove', id)
  confirmingRemove.value = null
}

function closeMenus() {
  openMenu.value = null
  confirmingRemove.value = null
}

// --- Edit-recurrence modal -------------------------------------------------

type Freq = 'daily' | 'weekly' | 'monthly'

const editFreq = ref<Freq>('daily')
const editInterval = ref(1)
const editWeekdays = ref<number[]>([])
const editDayOfMonth = ref(1)

function defaultSchedule(): NewSchedule {
  const dow = weekdayOf(props.date)
  return {
    freq: 'weekly',
    interval: 1,
    byweekday: [dow],
  }
}

function startEdit(r: ReminderRow) {
  openMenu.value = null
  editing.value = r
  const s = r.schedule
  // Monthly defaults its day-of-month to the viewed day when unset.
  editFreq.value = s?.freq ?? 'daily'
  editInterval.value = s?.interval && s.interval > 0 ? s.interval : 1
  editWeekdays.value = s?.byweekday?.length ? [...s.byweekday] : [weekdayOf(props.date)]
  editDayOfMonth.value =
    s?.day_of_month ?? dayOfMonthOf(props.date)
}

function toggleWeekday(d: number) {
  const i = editWeekdays.value.indexOf(d)
  if (i >= 0) editWeekdays.value.splice(i, 1)
  else editWeekdays.value.push(d)
}

const editValid = computed(() => {
  if (editFreq.value === 'weekly') {
    return editInterval.value >= 1 && editWeekdays.value.length > 0
  }
  if (editFreq.value === 'monthly') return editDayOfMonth.value >= 1 && editDayOfMonth.value <= 31
  return true
})

function saveEdit() {
  if (!editing.value || !editValid.value) return
  emit('updateSchedule', editing.value.id, {
    freq: editFreq.value,
    interval: editFreq.value === 'weekly' ? editInterval.value : undefined,
    byweekday: editFreq.value === 'weekly' ? [...editWeekdays.value] : undefined,
    day_of_month: editFreq.value === 'monthly' ? editDayOfMonth.value : undefined,
  })
  editing.value = null
}
</script>

<template>
  <section class="card bg-base-100 shadow-sm" @click="closeMenus">
    <div class="card-body p-0">
      <header class="flex items-center justify-between px-4 pt-3 pb-1">
        <h2 class="font-semibold flex items-center gap-2">
          <AppIcon name="check" class="w-4 h-4 text-accent" />
          Reminders
        </h2>
      </header>

      <ul v-if="reminders.length" class="divide-y divide-base-200">
        <li
          v-for="r in reminders"
          :key="r.id"
          class="flex items-center gap-2 px-4 py-1.5"
        >
          <!-- Todo checkbox. Text fades while ticked, back to full when not. -->
          <label class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-sm checkbox-accent"
              :checked="r.done"
              @change="emit('toggle', r.id, !r.done)"
            >
            <span class="min-w-0">
              <span
                class="block truncate font-medium text-sm transition-opacity duration-300"
                :class="r.done ? 'opacity-40' : ''"
              >{{ r.name }}</span>
              <span
                v-if="r.schedule_label"
                class="block text-xs text-base-content/40 truncate"
              >{{ r.schedule_label }}</span>
            </span>
          </label>

          <!-- Gear dropdown: Edit Recurrence / Delete Today's / Delete + Future -->
          <div class="relative shrink-0" @click.stop>
            <button
              class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-base-content"
              aria-label="Reminder options"
              @click="openMenu = openMenu === r.id ? null : r.id"
            >
              <AppIcon name="cog" class="w-4 h-4" />
            </button>

            <ul
              v-if="openMenu === r.id"
              class="menu absolute right-0 top-full z-30 mt-1 w-48 rounded-box bg-base-100 p-1 shadow-lg border border-base-200 text-sm"
            >
              <li><button @click="startEdit(r)">Edit Recurrence</button></li>
              <li><button @click="emit('skipToday', r.id); openMenu = null">Delete Today's</button></li>
              <li>
                <button
                  v-if="confirmingRemove !== r.id"
                  class="text-error"
                  @click="askRemove(r.id)"
                >Delete + Future…</button>
                <div v-else class="flex items-center gap-1 px-2 py-1">
                  <span class="text-xs flex-1">From today?</span>
                  <button class="btn btn-error btn-xs" @click="confirmRemove(r.id)">Yes</button>
                  <button class="btn btn-ghost btn-xs" @click="closeMenus">No</button>
                </div>
              </li>
            </ul>
          </div>
        </li>
      </ul>

      <p v-else-if="!adding" class="px-4 pb-1 text-sm text-base-content/40">
        No reminders yet.
      </p>

      <button
        v-if="!adding"
        class="btn btn-ghost btn-sm justify-start gap-2 m-2 mt-1 text-accent"
        @click.stop="adding = true"
      >
        <AppIcon name="plus" class="w-4 h-4" />
        Add reminder
      </button>

      <form v-else class="flex items-center gap-2 px-4 py-2" @submit.prevent="add">
        <input
          v-model="newName"
          type="text"
          class="input input-bordered input-sm flex-1"
          placeholder="Vitamin D, Meds…"
          maxlength="60"
          autofocus
        >
        <button type="submit" class="btn btn-accent btn-sm">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="adding = false">
          Cancel
        </button>
      </form>
    </div>

    <!-- Edit Recurrence modal --------------------------------------------- -->
    <dialog
      :open="editing !== null"
      class="modal"
      @click.self="editing = null"
    >
      <div v-if="editing" class="modal-box max-w-sm">
        <h3 class="font-semibold mb-1">{{ editing.name }}</h3>
        <p class="text-xs text-base-content/50 mb-3">
          Applies from {{ date }} onward — past days keep their old schedule.
        </p>

        <fieldset class="mb-3">
          <legend class="text-sm font-medium mb-1.5">Repeats</legend>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="f in ['daily', 'weekly', 'monthly'] as const"
              :key="f"
              class="btn btn-sm"
              :class="editFreq === f ? 'btn-accent' : 'btn-outline'"
              @click="editFreq = f"
            >{{ f[0]!.toUpperCase() + f.slice(1) }}</button>
          </div>
        </fieldset>

        <template v-if="editFreq === 'weekly'">
          <fieldset class="mb-3">
            <legend class="text-sm font-medium mb-1.5">Repeat every</legend>
            <div class="flex items-center gap-2">
              <input
                v-model.number="editInterval"
                type="number"
                min="1"
                max="52"
                class="input input-bordered input-sm w-20"
              >
              <span class="text-sm">{{ editInterval === 1 ? 'week' : 'weeks' }}</span>
            </div>
            <p v-if="editInterval === 2" class="text-xs text-base-content/50 mt-1">
              Every other week, anchored to {{ date }}.
            </p>
          </fieldset>

          <fieldset class="mb-3">
            <legend class="text-sm font-medium mb-1.5">On days</legend>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="(label, d) in WEEKDAY_LABELS"
                :key="d"
                class="btn btn-sm btn-square"
                :class="editWeekdays.includes(d) ? 'btn-accent' : 'btn-outline'"
                @click="toggleWeekday(d)"
              >{{ label }}</button>
            </div>
          </fieldset>
        </template>

        <fieldset v-if="editFreq === 'monthly'" class="mb-3">
          <legend class="text-sm font-medium mb-1.5">Day of month</legend>
          <input
            v-model.number="editDayOfMonth"
            type="number"
            min="1"
            max="31"
            class="input input-bordered input-sm w-24"
          >
          <p v-if="editDayOfMonth >= 29" class="text-xs text-base-content/50 mt-1">
            Months without this day are skipped.
          </p>
        </fieldset>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="editing = null">Cancel</button>
          <button
            class="btn btn-accent btn-sm"
            :disabled="!editValid"
            @click="saveEdit"
          >Save</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="editing = null" />
    </dialog>
  </section>
</template>
