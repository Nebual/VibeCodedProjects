<script setup lang="ts">
import type { Item } from '#shared/types'
import type { TagPatch } from '#shared/tags'
import { generateListName, parseBackupName } from '#shared/listName'

const props = defineProps<{ name: string }>()

// Fixed for the life of the component — the page re-keys on `name`.
const backup = parseBackupName(props.name)
const readOnly = backup !== null

const list = useShoppingList(props.name, { readOnly })
const { sorted, loaded, syncState, addItem, toggle, deleteItem, setTags } = list

const bulkModal = useTemplateRef<{ open: () => void }>('bulkModal')

const { preference: theme, setTheme } = useTheme()

function clearSearch() {
  query.value = ''
  searchInput.value?.focus()
}

const query = ref('')
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')

/** Relative timestamps go stale silently otherwise. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval>
onMounted(() => { clock = setInterval(() => now.value = Date.now(), 30_000) })
onBeforeUnmount(() => clearInterval(clock))

const needle = computed(() => query.value.trim().replace(/\s+/g, ' ').toLowerCase())

const visible = computed(() => {
  if (!needle.value) return sorted.value
  return sorted.value.filter(item => item.name.toLowerCase().includes(needle.value))
})

const remaining = computed(() => sorted.value.filter(item => !item.bought).length)

/**
 * Where to draw the line between "to buy" and "already bought". Anchored to the trailing
 * run of bought items, so ticking something off doesn't make the rule jump up the page
 * before the deferred re-sort has actually filed that item away.
 */
const dividerIndex = computed(() => {
  const list = visible.value
  let index = list.length
  while (index > 0 && list[index - 1]!.bought) index--
  return index > 0 && index < list.length ? index : -1
})

const exactMatch = computed(() => sorted.value.find(item => item.name.toLowerCase() === needle.value))

/** Typing something already on the list is only actionable if it's been bought — then it goes back on. */
const canAdd = computed(() => Boolean(needle.value) && (!exactMatch.value || exactMatch.value.bought))
const addLabel = computed(() => (exactMatch.value ? 'Add back' : 'Add'))

function submit() {
  if (!canAdd.value) return
  addItem(query.value)
  query.value = ''
  searchInput.value?.focus()
}

// ------------------------------------------------------------------ deleting

const pendingDelete = ref<Item | null>(null)
const confirmModal = useTemplateRef<HTMLDialogElement>('confirmModal')

/** DaisyUI dropdowns stay open while their button holds focus, so drop it before opening a modal. */
function closeDropdowns() {
  const active = document.activeElement as HTMLElement | null
  active?.blur?.()
}

function askDelete(item: Item) {
  pendingDelete.value = item
  closeDropdowns()
  confirmModal.value?.showModal()
}

function confirmDelete() {
  if (pendingDelete.value) deleteItem(pendingDelete.value)
  pendingDelete.value = null
  confirmModal.value?.close()
}

// ------------------------------------------------------------------ tagging

/**
 * Tagging is a mode rather than a control on every row. Colours describe areas of the
 * store, so they are almost always assigned a dozen at a time — "everything I just added
 * is produce" — and a per-row picker would turn that into a dozen separate errands. It
 * also keeps the row itself uncluttered for the thing it is actually for, which is
 * ticking items off one-handed in a shop.
 */
const selecting = ref(false)
const selectedIds = ref(new Set<string>())

const selectedItems = computed(() => sorted.value.filter(item => selectedIds.value.has(item.id)))

/**
 * What the picker shows as currently set. Only when the whole selection agrees — over a
 * mixed one it deliberately shows nothing active rather than the first item's tag, which
 * would misreport what a single tap is about to overwrite.
 */
function sharedTag<K extends 'color' | 'symbol'>(key: K): Item[K] | undefined {
  const [first, ...rest] = selectedItems.value
  if (!first) return undefined
  return rest.every(item => item[key] === first[key]) ? first[key] : undefined
}

const selectionColor = computed(() => sharedTag('color'))
const selectionSymbol = computed(() => sharedTag('symbol'))

function startSelecting() {
  closeDropdowns()
  selecting.value = true
  selectedIds.value = new Set()
}

function stopSelecting() {
  selecting.value = false
  selectedIds.value = new Set()
}

function clearSelection() {
  selectedIds.value = new Set()
}

// Replaced rather than mutated. Vue would track `.add` on a reactive Set perfectly
// well; the point is that `selectedItems` and the picker read this on every render, and a
// fresh Set keeps that a plain value swap rather than a collection whose identity persists
// across a mode the user can leave and re-enter.
function toggleSelect(item: Item) {
  const next = new Set(selectedIds.value)
  if (!next.delete(item.id)) next.add(item.id)
  selectedIds.value = next
}

/** Everything the search is currently showing — the fast path is filter, then tag the lot. */
function selectAllVisible() {
  selectedIds.value = new Set(visible.value.map(item => item.id))
}

function applyTag(patch: TagPatch) {
  setTags(selectedItems.value, patch)
  // The selection survives on purpose: a colour and then a symbol is two taps, not two
  // rounds of re-selecting the same twelve items.
}

// --------------------------------------------------------------------- menu

const shareModal = useTemplateRef<HTMLDialogElement>('shareModal')
const shareUrl = ref('')
const copied = ref(false)

function openShare() {
  shareUrl.value = window.location.href
  copied.value = false
  closeDropdowns()
  shareModal.value?.showModal()
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    copied.value = true
  }
  catch {
    copied.value = false
  }
}

function newList() {
  closeDropdowns()
  return navigateTo(`/l/${generateListName()}`)
}

const syncLabel = computed(() => readOnly
  ? `Backup of ${backup!.date}`
  : {
      idle: 'Saved',
      pending: 'Saving…',
      syncing: 'Saving…',
      error: 'Offline — will retry',
    }[syncState.value])
</script>

<template>
  <div class="mx-auto flex min-h-dvh w-full max-w-xl flex-col p-4">
    <!-- Header and search stay put; long lists scroll underneath them. -->
    <div class="sticky top-0 z-30 -mx-4 -mt-4 flex flex-col gap-3 bg-base-200/95 px-4 pb-3 pt-4 backdrop-blur">
      <header class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-xl font-bold">
            NShoppingList
          </h1>
          <p class="truncate text-xs text-base-content/60">
            <span class="font-mono">{{ name }}</span>
            <span aria-hidden="true"> · </span>
            <span :class="syncState === 'error' ? 'text-warning' : ''">{{ syncLabel }}</span>
          </p>
        </div>

        <div class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-ghost btn-circle" aria-label="Menu">
            <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" />
            </svg>
          </div>
          <ul tabindex="0" class="dropdown-content menu z-20 w-52 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
            <li v-if="!readOnly"><button type="button" @click="startSelecting">Select &amp; tag</button></li>
            <li><button type="button" @click="newList">New list</button></li>
            <li><button type="button" @click="openShare">Share</button></li>
            <li class="menu-title text-xs">
              Theme
            </li>
            <li v-for="option in THEME_OPTIONS" :key="option.value">
              <button
                type="button"
                :class="theme === option.value ? 'menu-active' : ''"
                :aria-pressed="theme === option.value"
                @click="setTheme(option.value)"
              >
                {{ option.label }}
              </button>
            </li>
          </ul>
        </div>
      </header>

      <div v-if="backup" class="flex items-center gap-2 rounded-box bg-warning/15 px-3 py-2 text-xs text-base-content/80">
        <span class="flex-1">Read-only backup from {{ backup.date }}.</span>
        <NuxtLink :to="`/l/${backup.source}`" class="link link-primary shrink-0 font-medium">
          Live list
        </NuxtLink>
      </div>

      <form v-else class="flex gap-2" @submit.prevent="submit">
        <label class="input input-bordered flex flex-1 items-center gap-2">
          <svg class="size-4 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" stroke-linecap="round" />
          </svg>
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            class="grow"
            placeholder="Search or add an item"
            enterkeyhint="done"
            autocomplete="off"
          >
          <button
            v-if="query"
            type="button"
            class="btn btn-ghost btn-xs btn-circle -mr-1 shrink-0"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        </label>
        <button v-if="canAdd" type="submit" class="btn btn-primary">
          {{ addLabel }}
        </button>
        <button v-else-if="!query.trim()" type="button" class="btn btn-outline" @click="bulkModal?.open()">
          Bulk
        </button>
      </form>
    </div>

    <main class="flex-1 pt-3">
      <div v-if="!loaded" class="flex justify-center py-12">
        <span class="loading loading-dots loading-lg opacity-40" />
      </div>

      <template v-else>
        <p class="mb-2 px-1 text-xs uppercase tracking-wide text-base-content/50">
          {{ remaining }} to buy
        </p>

        <ul v-if="visible.length" class="flex flex-col gap-1.5">
          <template v-for="(item, index) in visible" :key="item.id">
            <li v-if="index === dividerIndex" role="separator" class="py-1">
              <hr class="border-base-300">
            </li>
            <ShoppingItemRow
              :item="item"
              :now="now"
              :read-only="readOnly"
              :selectable="selecting"
              :selected="selectedIds.has(item.id)"
              @toggle="toggle(item)"
              @remove="askDelete(item)"
              @select="toggleSelect(item)"
            />
          </template>
        </ul>

        <p v-else-if="needle" class="py-10 text-center text-sm text-base-content/60">
          Nothing matches “{{ query.trim() }}”. Press Add to put it on the list.
        </p>
        <p v-else class="py-10 text-center text-sm text-base-content/60">
          {{ readOnly ? 'This backup is empty.' : 'This list is empty. Search above to add your first item.' }}
        </p>
      </template>
    </main>

    <!-- Pinned to the bottom, within thumb reach, since the other hand is holding a trolley. -->
    <div
      v-if="selecting"
      class="sticky bottom-0 z-30 -mx-4 mt-3 flex flex-col gap-2 border-t border-base-300 bg-base-200/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur"
    >
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium">{{ selectedItems.length }} selected</span>
        <button type="button" class="btn btn-ghost btn-xs" @click="selectAllVisible">
          {{ needle ? 'Select all shown' : 'Select all' }}
        </button>
        <button v-if="selectedItems.length" type="button" class="btn btn-ghost btn-xs" @click="clearSelection">
          Clear
        </button>
        <span class="flex-1" />
        <button type="button" class="btn btn-sm" @click="stopSelecting">
          Done
        </button>
      </div>

      <TagPicker
        :color="selectionColor"
        :symbol="selectionSymbol"
        :disabled="!selectedItems.length"
        role="group"
        aria-label="Tag the selected items"
        @pick="applyTag"
      />

      <p v-if="!selectedItems.length" class="text-xs text-base-content/60">
        Tick the items that live in the same part of the shop, then give them a colour.
      </p>
    </div>

    <BulkAddModal v-if="!readOnly" ref="bulkModal" :list="list" />

    <dialog ref="confirmModal" class="modal">
      <div class="modal-box">
        <h3 class="text-lg font-bold">
          Delete item?
        </h3>
        <p class="py-4">
          “{{ pendingDelete?.name }}” will be removed from this list on every device. This can't be undone.
        </p>
        <div class="modal-action">
          <form method="dialog">
            <button class="btn btn-ghost" @click="pendingDelete = null">
              Cancel
            </button>
          </form>
          <button type="button" class="btn btn-error" @click="confirmDelete">
            Delete
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button @click="pendingDelete = null">close</button>
      </form>
    </dialog>

    <dialog ref="shareModal" class="modal">
      <div class="modal-box">
        <h3 class="text-lg font-bold">
          Share this list
        </h3>
        <p class="py-4">
          You can share this list with anyone by sending them the link. I hope you weren't expecting social
          media tie-ins like a one-click post my grocery list to instagram button!
        </p>
        <div class="join w-full">
          <input class="input input-bordered join-item w-full font-mono text-xs" :value="shareUrl" readonly>
          <button type="button" class="btn join-item" @click="copyLink">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </div>
        <div class="modal-action">
          <form method="dialog">
            <button class="btn">
              Close
            </button>
          </form>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  </div>
</template>
