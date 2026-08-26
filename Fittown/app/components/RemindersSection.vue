<script setup lang="ts">
import type { ReminderRow } from '~/composables/useDiary'

const props = defineProps<{
  reminders: ReminderRow[]
  date: string
}>()

const emit = defineEmits<{
  add: [name: string]
  toggle: [id: number, done: boolean]
  remove: [id: number]
}>()

const adding = ref(false)
const newName = ref('')

/** Ticking a box is per-day: the same reminder starts unticked tomorrow. */
function toggle(r: ReminderRow) {
  emit('toggle', r.id, !r.done)
}

function add() {
  const name = newName.value.trim()
  if (!name) return
  emit('add', name)
  newName.value = ''
  adding.value = false
}

/**
 * Two taps to remove a reminder entirely — and only from today onward.
 * Past days keep the checkbox they had, so history never rewrites itself.
 */
const confirmingRemove = ref<number | null>(null)

function askRemove(id: number) {
  confirmingRemove.value = id
}

function confirmRemove(id: number) {
  emit('remove', id)
  confirmingRemove.value = null
}

const list = computed(() => props.reminders)
</script>

<template>
  <section class="card bg-base-100 shadow-sm">
    <div class="card-body p-0">
      <header class="flex items-center justify-between px-4 pt-3 pb-1">
        <h2 class="font-semibold flex items-center gap-2">
          <AppIcon name="check" class="w-4 h-4 text-accent" />
          Reminders
        </h2>
      </header>

      <ul v-if="list.length" class="divide-y divide-base-200">
        <li
          v-for="r in list"
          :key="r.id"
          class="flex items-center gap-3 px-4 py-1.5"
        >
          <!-- Todo checkbox. Text fades while ticked, back to full when not. -->
          <label class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-sm checkbox-accent"
              :checked="r.done"
              @change="toggle(r)"
            >
            <span
              class="truncate font-medium text-sm transition-opacity duration-300"
              :class="r.done ? 'opacity-40' : ''"
            >{{ r.name }}</span>
          </label>

          <button
            v-if="confirmingRemove !== r.id"
            class="btn btn-ghost btn-xs btn-square text-base-content/40 hover:text-error"
            aria-label="Remove reminder"
            @click="askRemove(r.id)"
          >
            <AppIcon name="trash" class="w-4 h-4" />
          </button>
          <div v-else class="flex items-center gap-1 shrink-0">
            <span class="text-xs text-base-content/50">Remove?</span>
            <button
              class="btn btn-error btn-xs"
              @click="confirmRemove(r.id)"
            >Yes</button>
            <button
              class="btn btn-ghost btn-xs"
              @click="confirmingRemove = null"
            >No</button>
          </div>
        </li>
      </ul>

      <p v-else-if="!adding" class="px-4 pb-1 text-sm text-base-content/40">
        No reminders yet.
      </p>

      <button
        v-if="!adding"
        class="btn btn-ghost btn-sm justify-start gap-2 m-2 mt-1 text-accent"
        @click="adding = true"
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
  </section>
</template>
