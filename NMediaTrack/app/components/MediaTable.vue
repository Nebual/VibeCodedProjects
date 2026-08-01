<script setup lang="ts">
import { averageStars, reviewBy, STATUS_META, TYPE_META } from '~~/shared/types'
import type { MediaItem } from '~~/shared/types'
import type { SortDir, SortKey } from '~/utils/sortMedia'

// Compact table alternative to the card grid. Rows arrive pre-sorted; this
// component only reports which header was clicked.
const props = defineProps<{
  items: MediaItem[]
  sortKey: SortKey
  sortDir: SortDir
  highlightedId?: string | null
}>()

const emit = defineEmits<{
  sort: [key: SortKey]
  edit: [item: MediaItem]
  deleted: []
}>()

const { name } = useUser()
const { canEdit, canDelete, remove, touch } = useMedia()

const COLUMNS: { key: SortKey; label: string; class?: string }[] = [
  { key: 'type', label: '', class: 'w-8' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status', class: 'hidden sm:table-cell' },
  { key: 'people', label: 'With', class: 'hidden md:table-cell' },
  { key: 'group', label: 'Group', class: 'hidden lg:table-cell' },
  { key: 'stars', label: 'Rating', class: 'hidden sm:table-cell' },
  { key: 'recent', label: 'Last active' },
]

const busyId = ref<string | null>(null)

function arrow(key: SortKey) {
  if (props.sortKey !== key) return ''
  return props.sortDir === 'asc' ? '▲' : '▼'
}

const isOwn = (item: MediaItem) =>
  item.owner.trim().toLowerCase() === name.value.trim().toLowerCase()

function myStars(item: MediaItem) {
  return reviewBy(item, name.value)?.stars ?? 0
}

/** Reviews by other people, for the "+N" hint next to your own rating. */
function otherReviews(item: MediaItem) {
  const me = name.value.trim().toLowerCase()
  return item.reviews.filter((r) => r.author.trim().toLowerCase() !== me)
}

async function markToday(item: MediaItem) {
  busyId.value = item.id
  try {
    await touch(item.id)
  } finally {
    busyId.value = null
  }
}

async function onDelete(item: MediaItem) {
  if (!confirm(`Delete "${item.title}" from your library?`)) return
  busyId.value = item.id
  try {
    await remove(item.id)
    emit('deleted')
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="overflow-x-auto rounded-box border-2 border-base-content/15 bg-base-100">
    <table class="table table-sm">
      <thead>
        <tr>
          <th
            v-for="col in COLUMNS"
            :key="col.key"
            :class="col.class"
            class="cursor-pointer select-none whitespace-nowrap hover:bg-base-200"
            :aria-sort="
              sortKey === col.key
                ? sortDir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'
            "
            @click="emit('sort', col.key)"
          >
            {{ col.label }}
            <span class="text-[0.6rem] opacity-70">{{ arrow(col.key) }}</span>
          </th>
          <th class="w-8" />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in items"
          :id="`media-${item.id}`"
          :key="item.id"
          class="hover:bg-base-200/60"
          :class="{ 'pick-highlight': highlightedId === item.id }"
        >
          <!-- Type icon, smaller than on the cards -->
          <td class="text-base leading-none" :title="TYPE_META[item.type].label">
            {{ TYPE_META[item.type].icon }}
          </td>

          <!-- Title (+ episode, owner, notes hint) -->
          <td>
            <div class="flex flex-wrap items-center gap-1.5">
              <a
                v-if="lookupUrl(item)"
                :href="lookupUrl(item)!"
                target="_blank"
                rel="noopener noreferrer"
                class="font-medium decoration-dotted underline-offset-2 hover:link-primary hover:underline"
                :title="lookupLabel(item)"
              >{{ item.title }}</a>
              <span v-else class="font-medium">{{ item.title }}</span>
              <span
                v-if="item.type === 'show' && item.lastEpisode"
                class="badge badge-primary badge-xs font-mono"
              >{{ item.lastEpisode }}</span>
              <span v-if="!isOwn(item)" class="badge badge-outline badge-xs">
                {{ item.owner }}
              </span>
            </div>
            <!-- Details that get their own columns on wider screens -->
            <div class="mt-0.5 flex flex-wrap gap-1 text-xs opacity-60 sm:hidden">
              <span>{{ STATUS_META[item.status].label }}</span>
              <span v-if="item.companions.length">· {{ item.companions.join(', ') }}</span>
            </div>
          </td>

          <td class="hidden sm:table-cell">
            <span class="badge badge-sm" :class="STATUS_META[item.status].badge">
              {{ STATUS_META[item.status].label }}
            </span>
          </td>

          <td class="hidden md:table-cell">
            <span v-if="!item.companions.length" class="opacity-40">—</span>
            <span v-else class="text-sm">{{ item.companions.join(', ') }}</span>
          </td>

          <td class="hidden whitespace-nowrap lg:table-cell">
            <span v-if="item.minPlayers" class="badge badge-primary badge-outline badge-xs">
              min {{ item.minPlayers }}
            </span>
            <span v-if="item.soloable" class="badge badge-accent badge-outline badge-xs">
              solo
            </span>
            <span v-if="!item.minPlayers && !item.soloable" class="opacity-40">—</span>
          </td>

          <!-- Your rating, with a note when others have reviewed too -->
          <td class="hidden whitespace-nowrap sm:table-cell">
            <span v-if="myStars(item)" class="text-warning">
              {{ '★'.repeat(myStars(item)) }}<span class="opacity-25">{{ '★'.repeat(5 - myStars(item)) }}</span>
            </span>
            <span v-else-if="item.reviews.length" class="text-sm opacity-60">
              {{ averageStars(item).toFixed(1) }}★ avg
            </span>
            <span v-else class="opacity-40">—</span>
            <span
              v-if="myStars(item) && otherReviews(item).length"
              class="ml-1 text-xs opacity-50"
            >+{{ otherReviews(item).length }}</span>
          </td>

          <td class="whitespace-nowrap text-sm opacity-70">
            {{ timeAgo(item.lastActivityAt) }}
          </td>

          <td>
            <div v-if="canEdit(item)" class="dropdown dropdown-end">
              <div tabindex="0" role="button" class="btn btn-ghost btn-xs btn-square">⋯</div>
              <ul
                tabindex="0"
                class="menu dropdown-content z-20 w-40 rounded-box bg-base-200 p-2 shadow-lg"
              >
                <li><a @click="emit('edit', item)">✏️ Edit</a></li>
                <li><a @click="markToday(item)">✅ Did this today</a></li>
                <li v-if="canDelete(item)">
                  <a class="text-error" @click="onDelete(item)">🗑️ Delete</a>
                </li>
              </ul>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
