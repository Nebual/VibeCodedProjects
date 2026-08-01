<script setup lang="ts">
import { STATUS_META, TYPE_META } from '~~/shared/types'
import type { MediaItem } from '~~/shared/types'

const props = defineProps<{
  item: MediaItem
  editable?: boolean
  highlighted?: boolean
}>()
const emit = defineEmits<{ edit: [item: MediaItem]; deleted: [] }>()

const { update, remove, touch } = useMedia()

const meta = computed(() => TYPE_META[props.item.type])
const statusMeta = computed(() => STATUS_META[props.item.status])
const lastActivity = computed(() => props.item.lastActivityAt)

// Flag long-neglected active/paused items as "worth revisiting".
const stale = computed(() => {
  if (!['active', 'paused'].includes(props.item.status)) return false
  return daysSince(lastActivity.value) >= 21
})

const busy = ref(false)

async function markToday() {
  busy.value = true
  try {
    await touch(props.item.id)
  } finally {
    busy.value = false
  }
}

async function onDelete() {
  if (!confirm(`Delete "${props.item.title}" from your library?`)) return
  busy.value = true
  try {
    await remove(props.item.id)
    emit('deleted')
  } finally {
    busy.value = false
  }
}

async function cycleStatus() {
  // Quick-advance through the common lifecycle without opening the editor.
  const order = ['backlog', 'active', 'paused', 'completed', 'dropped'] as const
  const idx = order.indexOf(props.item.status)
  const next = order[(idx + 1) % order.length]!
  busy.value = true
  try {
    await update(props.item.id, { status: next })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <!-- base-300 sits too close to the page background on the dark theme, so the
       border is drawn from base-content at low opacity — that reads on both. -->
  <div
    class="card card-lift border-2 border-base-content/15 bg-base-100 shadow-md"
    :class="{ 'pick-highlight': highlighted }"
  >
    <div class="card-body gap-3 p-5">
      <!-- Header -->
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-start gap-3">
          <div class="text-3xl leading-none" :title="meta.label">{{ meta.icon }}</div>
          <div>
            <h3 class="text-lg font-semibold leading-tight">{{ item.title }}</h3>
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <button
                class="badge badge-sm"
                :class="statusMeta.badge"
                :disabled="!editable || busy"
                :title="editable ? 'Click to advance status' : ''"
                @click="editable && cycleStatus()"
              >
                {{ statusMeta.label }}
              </button>
              <span class="badge badge-ghost badge-sm">{{ meta.label }}</span>
              <span v-if="!editable" class="badge badge-outline badge-sm">
                by {{ item.owner }}
              </span>
            </div>
          </div>
        </div>

        <!-- Owner actions -->
        <div v-if="editable" class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-ghost btn-sm btn-square">⋯</div>
          <ul tabindex="0" class="menu dropdown-content z-10 w-40 rounded-box bg-base-200 p-2 shadow-lg">
            <li><a @click="emit('edit', item)">✏️ Edit</a></li>
            <li><a @click="markToday">✅ Did this today</a></li>
            <li><a class="text-error" @click="onDelete">🗑️ Delete</a></li>
          </ul>
        </div>
      </div>

      <!-- Show: last episode -->
      <div v-if="item.type === 'show' && item.lastEpisode" class="text-sm">
        <span class="opacity-60">Up to:</span>
        <span class="badge badge-primary badge-sm ml-1 font-mono">{{ item.lastEpisode }}</span>
      </div>

      <!-- Companions -->
      <div v-if="item.companions.length" class="flex flex-wrap items-center gap-1 text-sm">
        <span class="opacity-60">With</span>
        <span
          v-for="c in item.companions"
          :key="c"
          class="badge badge-secondary badge-sm"
        >{{ c }}</span>
      </div>

      <!-- Notes -->
      <p v-if="item.notes" class="text-sm opacity-80">{{ item.notes }}</p>

      <!-- Review -->
      <div v-if="item.review" class="rounded-box bg-base-200/60 p-3">
        <StarRating :model-value="item.review.stars" readonly size="sm" />
        <p v-if="item.review.message" class="mt-1 text-sm italic opacity-90">
          "{{ item.review.message }}"
        </p>
      </div>

      <!-- Footer: last activity -->
      <div class="mt-1 flex items-center justify-between text-xs">
        <span class="flex items-center gap-1 opacity-60">
          Last {{ meta.noun }} {{ timeAgo(lastActivity) }}
        </span>
        <span v-if="stale" class="badge badge-warning badge-sm gap-1">
          ⏳ pick back up?
        </span>
      </div>
    </div>
  </div>
</template>
